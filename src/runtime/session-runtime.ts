import { randomBytes, randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";

import {
  type SpawnAppServerOptions,
  type SpawnedAppServer,
  spawnCodexAppServer,
} from "../app-server/process.js";
import { AppServerConnectionClosedError } from "../app-server/protocol.js";
import { ControlPlaneServer } from "../control-plane/ipc-server.js";
import {
  CAME_CONTROL_SOCKET_ENV,
  CAME_CONTROL_TOKEN_ENV,
} from "../control-plane/protocol.js";
import { HandoffEngine } from "../handoff/handoff-engine.js";
import {
  SessionGatewayDisconnectedError,
  WebSocketGateway,
} from "./websocket-gateway.js";

export const CAME_SESSION_ID_ENV = "CAME_SESSION_ID";
export const CAME_RUNTIME_DIR_ENV = "CAME_RUNTIME_DIR";
export const CAME_TUI_AUTH_TOKEN_ENV = "CAME_TUI_AUTH_TOKEN";
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

type RuntimeState = "idle" | "starting" | "running" | "stopping" | "stopped";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export type SessionRuntimeOptions = {
  cwd?: string;
  codexCommand?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  stderr?: Writable;
  tuiStdio?: "inherit" | "ignore";
  spawnAppServer?: (options: SpawnAppServerOptions) => SpawnedAppServer;
  spawnTui?: typeof spawn;
};

export class SessionRuntimeError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionRuntimeError";
  }
}

export class SessionRuntime {
  readonly #options: SessionRuntimeOptions;
  #state: RuntimeState = "idle";
  #runtimeDir: string | null = null;
  #appServer: SpawnedAppServer | null = null;
  #gateway: WebSocketGateway | null = null;
  #controlServer: ControlPlaneServer | null = null;
  #handoffEngine: HandoffEngine | null = null;
  #tui: ChildProcess | null = null;
  #completion: Deferred<number> | null = null;
  #stopped: Deferred<void> | null = null;
  #stopRequested = false;
  #terminalError: Error | null = null;
  #cleanupError: Error | null = null;
  #cleanupPromise: Promise<void> | null = null;

  public constructor(options: SessionRuntimeOptions = {}) {
    validatePositiveTimeout(options.startupTimeoutMs, "Startup timeout");
    validateNonNegativeTimeout(options.shutdownGraceMs, "Shutdown grace period");
    this.#options = options;
  }

  public get state(): RuntimeState {
    return this.#state;
  }

  public async run(): Promise<number> {
    if (this.#state !== "idle") {
      throw new SessionRuntimeError("SessionRuntime can only run once");
    }
    this.#state = "starting";
    this.#completion = createDeferred<number>();
    this.#stopped = createDeferred<void>();
    let runError: unknown;

    try {
      const cwd = resolve(this.#options.cwd ?? process.cwd());
      const sessionId = randomUUID();
      const authToken = randomBytes(32).toString("base64url");
      const controlToken = randomBytes(32).toString("base64url");
      this.#runtimeDir = await mkdtemp(join(tmpdir(), "came-"));
      await chmod(this.#runtimeDir, 0o700);
      if (this.#stopRequested) {
        return await this.#completion.promise;
      }
      const controlSocketPath = join(this.#runtimeDir, "control.sock");
      const appServerEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...this.#options.env,
        [CAME_SESSION_ID_ENV]: sessionId,
        [CAME_RUNTIME_DIR_ENV]: this.#runtimeDir,
      };
      const tuiEnv: NodeJS.ProcessEnv = {
        ...appServerEnv,
        [CAME_TUI_AUTH_TOKEN_ENV]: authToken,
        [CAME_CONTROL_SOCKET_ENV]: controlSocketPath,
        [CAME_CONTROL_TOKEN_ENV]: controlToken,
      };

      const spawnAppServer = this.#options.spawnAppServer ?? spawnCodexAppServer;
      const appServerOptions: SpawnAppServerOptions = {
        cwd,
        env: appServerEnv,
        requestTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      };
      if (this.#options.codexCommand !== undefined) {
        appServerOptions.command = this.#options.codexCommand;
      }
      if (this.#options.stderr !== undefined) {
        appServerOptions.stderr = this.#options.stderr;
      }
      this.#appServer = spawnAppServer(appServerOptions);
      this.#appServer.bridge.onClose((error) => this.#fail(new SessionRuntimeError("Codex App Server stopped", { cause: error })));

      this.#handoffEngine = new HandoffEngine({
        sessionId,
        bridge: this.#appServer.bridge,
        onFatalError: (error) => this.#fail(new SessionRuntimeError("Model handoff failed", { cause: error })),
      });
      this.#controlServer = new ControlPlaneServer({
        socketPath: controlSocketPath,
        sessionId,
        authToken: controlToken,
        handler: this.#handoffEngine,
        onFatalError: (error) => this.#fail(new SessionRuntimeError("MCP control plane failed", { cause: error })),
      });
      await this.#controlServer.start();
      if (this.#terminalError !== null) {
        throw this.#terminalError;
      }
      if (this.#stopRequested) {
        return await this.#completion.promise;
      }

      this.#gateway = new WebSocketGateway(
        this.#appServer.bridge,
        authToken,
        (error) => {
          void this.#handleGatewayFailure(error);
        },
      );
      const remoteAddress = await this.#gateway.start();
      if (this.#terminalError !== null) {
        throw this.#terminalError;
      }
      if (this.#stopRequested) {
        return await this.#completion.promise;
      }

      const spawnTui = this.#options.spawnTui ?? spawn;
      this.#tui = spawnTui(this.#options.codexCommand ?? "codex", [
        "--remote",
        remoteAddress,
        "--remote-auth-token-env",
        CAME_TUI_AUTH_TOKEN_ENV,
      ], {
        cwd,
        env: tuiEnv,
        stdio: this.#options.tuiStdio ?? "inherit",
      });
      this.#tui.once("error", (error) => this.#fail(new SessionRuntimeError("Could not start Codex TUI", { cause: error })));
      this.#tui.once("exit", (code, signal) => {
        if (this.#state === "starting") {
          this.#fail(new SessionRuntimeError(`Codex TUI exited before connecting with code ${String(code)} and signal ${String(signal)}`));
          return;
        }
        if (this.#state === "running") {
          this.#completion?.resolve(code ?? signalExitCode(signal));
        }
      });

      const startupOutcome = await Promise.race([
        this.#gateway.waitForClient(this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
          .then(() => ({ type: "connected" as const })),
        this.#completion.promise.then((exitCode) => ({ type: "stopped" as const, exitCode })),
      ]);
      if (startupOutcome.type === "stopped") {
        return startupOutcome.exitCode;
      }
      if (this.#state !== "starting") {
        throw new SessionRuntimeError("CaMe session left startup unexpectedly");
      }
      this.#state = "running";
      return await this.#completion.promise;
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      try {
        await this.#cleanup();
      } catch (cleanupError) {
        if (runError !== undefined) {
          throw new AggregateError(
            [runError, cleanupError],
            "CaMe session failed and its cleanup also failed",
          );
        }
        throw cleanupError;
      }
    }
  }

  public async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopped") {
      return;
    }
    this.requestStop(signal);
    await this.#stopped?.promise;
    if (this.#cleanupError !== null) {
      throw this.#cleanupError;
    }
  }

  public requestStop(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.#state === "idle" || this.#state === "stopped") {
      return;
    }
    this.#stopRequested = true;
    this.#completion?.resolve(signalExitCode(signal));
  }

  #fail(error: Error): void {
    if (this.#state === "stopping" || this.#state === "stopped") {
      return;
    }
    if (this.#terminalError !== null) {
      return;
    }
    this.#terminalError = error;
    this.#completion?.reject(error);
  }

  async #handleGatewayFailure(error: Error): Promise<void> {
    if (!(error instanceof SessionGatewayDisconnectedError)) {
      this.#fail(error);
      return;
    }
    const tui = this.#tui;
    if (tui === null) {
      this.#fail(error);
      return;
    }
    const graceMs = this.#options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    if (!await waitForChildExit(tui, graceMs)) {
      this.#fail(error);
    }
  }

  #cleanup(): Promise<void> {
    if (this.#cleanupPromise !== null) {
      return this.#cleanupPromise;
    }
    this.#cleanupPromise = this.#performCleanup();
    return this.#cleanupPromise;
  }

  async #performCleanup(): Promise<void> {
    this.#state = "stopping";
    const errors: Error[] = [];

    try {
      await this.#gateway?.close();
    } catch (error) {
      errors.push(asError(error));
    }
    this.#gateway = null;

    const graceMs = this.#options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    try {
      await terminateChild(this.#tui, graceMs);
    } catch (error) {
      errors.push(asError(error));
    }
    this.#tui = null;

    try {
      await this.#controlServer?.close();
    } catch (error) {
      errors.push(asError(error));
    }
    this.#controlServer = null;
    this.#handoffEngine?.close();
    this.#handoffEngine = null;

    try {
      this.#appServer?.bridge.close(new AppServerConnectionClosedError("CaMe session stopped"));
    } catch (error) {
      errors.push(asError(error));
    }
    try {
      await terminateChild(this.#appServer?.child ?? null, graceMs);
    } catch (error) {
      errors.push(asError(error));
    }
    this.#appServer = null;

    if (this.#runtimeDir !== null) {
      try {
        await rm(this.#runtimeDir, { recursive: true, force: false });
      } catch (error) {
        errors.push(asError(error));
      }
      this.#runtimeDir = null;
    }
    this.#state = "stopped";
    if (errors.length > 0) {
      this.#cleanupError = errors.length === 1
        ? errors[0] ?? new SessionRuntimeError("CaMe cleanup failed")
        : new AggregateError(errors, "CaMe cleanup failed");
    }
    this.#stopped?.resolve(undefined);
    if (this.#cleanupError !== null) {
      throw this.#cleanupError;
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === null || rejectPromise === null) {
    throw new SessionRuntimeError("Could not initialize deferred state");
  }
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function terminateChild(child: ChildProcess | null, graceMs: number): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const terminated = child.kill("SIGTERM");
  if (!terminated && child.exitCode === null && child.signalCode === null) {
    throw new SessionRuntimeError(`Could not send SIGTERM to child process ${String(child.pid)}`);
  }
  const graceful = await waitForChildExit(child, graceMs);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    const killed = child.kill("SIGKILL");
    if (!killed && child.exitCode === null && child.signalCode === null) {
      throw new SessionRuntimeError(`Could not send SIGKILL to child process ${String(child.pid)}`);
    }
    if (!await waitForChildExit(child, graceMs)) {
      throw new SessionRuntimeError(`Child process ${String(child.pid)} did not exit after SIGKILL`);
    }
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) {
    return 1;
  }
  const signalNumber = osConstants.signals[signal];
  if (signalNumber === undefined) {
    throw new RangeError(`Signal ${signal} is not supported on this platform`);
  }
  return 128 + signalNumber;
}

function validatePositiveTimeout(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function validateNonNegativeTimeout(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new SessionRuntimeError(String(error));
}
