import { type ChildProcessWithoutNullStreams, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { statSync } from "node:fs";
import { access } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  AppServerBridge,
  CAME_RUNTIME_DIR_ENV,
  CAME_SESSION_ID_ENV,
  CAME_TUI_AUTH_TOKEN_ENV,
  CAME_CONTROL_SOCKET_ENV,
  CAME_CONTROL_TOKEN_ENV,
  SessionGatewayError,
  SessionRuntime,
  type SpawnAppServerOptions,
  type SpawnedAppServer,
} from "../../src/index.js";

const KEEP_ALIVE_SCRIPT = "setInterval(() => undefined, 1_000)";
const IGNORE_SIGTERM_SCRIPT = [
  "const { writeFileSync } = require('node:fs');",
  "process.on('SIGTERM', () => undefined);",
  `writeFileSync(process.env.${CAME_RUNTIME_DIR_ENV} + '/app-ready', '');`,
  "setInterval(() => undefined, 1_000);",
].join("\n");

type RuntimeHarness = {
  appChildren: ChildProcessWithoutNullStreams[];
  appOptions: SpawnAppServerOptions[];
  runtimeDirs: string[];
  tuiChildren: ChildProcessWithoutNullStreams[];
  tuiEnvironments: NodeJS.ProcessEnv[];
  spawnAppServer: (options: SpawnAppServerOptions) => SpawnedAppServer;
  spawnTui: typeof spawn;
};

function createRuntimeHarness(options: {
  connect?: boolean;
  disconnect?: boolean;
  appScript?: string;
  tuiExitCode?: number;
  waitForAppReady?: boolean;
} = {}): RuntimeHarness {
  const appChildren: ChildProcessWithoutNullStreams[] = [];
  const appOptions: SpawnAppServerOptions[] = [];
  const runtimeDirs: string[] = [];
  const tuiChildren: ChildProcessWithoutNullStreams[] = [];
  const tuiEnvironments: NodeJS.ProcessEnv[] = [];
  const spawnAppServer = (spawnOptions: SpawnAppServerOptions): SpawnedAppServer => {
    const child = spawn(process.execPath, ["-e", options.appScript ?? KEEP_ALIVE_SCRIPT], {
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    appChildren.push(child);
    appOptions.push(spawnOptions);
    return {
      child,
      bridge: new AppServerBridge(child.stdout, child.stdin),
    };
  };
  const spawnTui = ((command: string, args: readonly string[], spawnOptions: SpawnOptionsWithoutStdio) => {
    const remoteIndex = args.indexOf("--remote");
    const tokenNameIndex = args.indexOf("--remote-auth-token-env");
    if (remoteIndex < 0 || tokenNameIndex < 0) {
      throw new Error(`Missing remote arguments for ${command}`);
    }
    const address = args[remoteIndex + 1];
    const tokenName = args[tokenNameIndex + 1];
    const env = spawnOptions.env ?? {};
    if (address === undefined || tokenName === undefined) {
      throw new Error("Incomplete remote arguments");
    }
    const token = env[tokenName];
    const runtimeDir = env[CAME_RUNTIME_DIR_ENV];
    const controlSocket = env[CAME_CONTROL_SOCKET_ENV];
    const controlToken = env[CAME_CONTROL_TOKEN_ENV];
    if (token === undefined || runtimeDir === undefined || controlSocket === undefined || controlToken === undefined) {
      throw new Error("Missing runtime environment");
    }
    runtimeDirs.push(runtimeDir);
    tuiEnvironments.push(env);
    expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(controlSocket).mode & 0o777).toBe(0o600);
    expect(statSync(`${runtimeDir}/audit.jsonl`).mode & 0o777).toBe(0o600);
    expect(controlToken).not.toBe(token);

    const script = options.connect === false
      ? KEEP_ALIVE_SCRIPT
      : [
          "import { WebSocket } from 'ws';",
          "import { existsSync } from 'node:fs';",
          "const [address, token, exitCode] = process.argv.slice(1);",
          options.waitForAppReady === true
            ? `while (!existsSync(process.env.${CAME_RUNTIME_DIR_ENV} + '/app-ready')) await new Promise((resolve) => setTimeout(resolve, 5));`
            : "",
          "const socket = new WebSocket(address, { headers: { authorization: `Bearer ${token}` } });",
          "socket.once('open', () => {",
          options.disconnect === true
            ? "  socket.close(); setInterval(() => undefined, 1_000);"
            : options.tuiExitCode === undefined
            ? "  setInterval(() => undefined, 1_000);"
            : "  setTimeout(() => process.exit(Number(exitCode)), 75);",
          "});",
          "socket.once('error', (error) => { console.error(error.message); process.exit(91); });",
          options.disconnect === true ? "" : "socket.once('close', () => process.exit(0));",
        ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, address, token, String(options.tuiExitCode ?? 0)], {
      cwd: spawnOptions.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    tuiChildren.push(child);
    return child;
  }) as typeof spawn;
  return {
    appChildren,
    appOptions,
    runtimeDirs,
    tuiChildren,
    tuiEnvironments,
    spawnAppServer,
    spawnTui,
  };
}

describe("SessionRuntime", () => {
  it("creates an isolated session, launches the remote TUI, and removes the runtime directory", async () => {
    const harness = createRuntimeHarness({ tuiExitCode: 7 });
    const runtime = new SessionRuntime({
      shutdownGraceMs: 100,
      spawnAppServer: harness.spawnAppServer,
      spawnTui: harness.spawnTui,
      tuiStdio: "ignore",
    });

    await expect(runtime.run()).resolves.toBe(7);

    expect(runtime.state).toBe("stopped");
    expect(harness.appOptions).toHaveLength(1);
    expect(harness.appOptions[0]?.env?.[CAME_SESSION_ID_ENV]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(harness.appOptions[0]?.env?.[CAME_TUI_AUTH_TOKEN_ENV]).toBeUndefined();
    expect(harness.appOptions[0]?.env?.[CAME_CONTROL_TOKEN_ENV]).toBeUndefined();
    expect(harness.tuiEnvironments[0]?.[CAME_SESSION_ID_ENV]).toBe(harness.appOptions[0]?.env?.[CAME_SESSION_ID_ENV]);
    expect(harness.tuiEnvironments[0]?.[CAME_TUI_AUTH_TOKEN_ENV]?.length).toBeGreaterThanOrEqual(32);
    expect(harness.runtimeDirs).toHaveLength(1);
    const runtimeDir = harness.runtimeDirs[0];
    const appChild = harness.appChildren[0];
    if (runtimeDir === undefined || appChild === undefined) {
      throw new Error("Expected one complete runtime launch");
    }
    await expect(access(runtimeDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(appChild.exitCode !== null || appChild.signalCode !== null).toBe(true);
  });

  it("stops a running session with the requested signal exit code", async () => {
    const harness = createRuntimeHarness();
    const runtime = new SessionRuntime({
      shutdownGraceMs: 100,
      spawnAppServer: harness.spawnAppServer,
      spawnTui: harness.spawnTui,
      tuiStdio: "ignore",
    });
    const running = runtime.run();
    await expect.poll(() => runtime.state).toBe("running");

    const stopping = runtime.stop("SIGINT");

    await expect(running).resolves.toBe(130);
    await expect(stopping).resolves.toBeUndefined();
    expect(runtime.state).toBe("stopped");
  });

  it("honors a stop request issued during asynchronous startup without spawning children", async () => {
    const spawnAppServer = vi.fn<(options: SpawnAppServerOptions) => SpawnedAppServer>();
    const spawnTui = vi.fn() as unknown as typeof spawn;
    const runtime = new SessionRuntime({ spawnAppServer, spawnTui });

    const running = runtime.run();
    runtime.requestStop("SIGINT");

    await expect(running).resolves.toBe(130);
    expect(spawnAppServer).not.toHaveBeenCalled();
    expect(spawnTui).not.toHaveBeenCalled();
    expect(runtime.state).toBe("stopped");
  });

  it("fails on a TUI connection timeout and cleans up both child processes", async () => {
    const harness = createRuntimeHarness({ connect: false });
    const runtime = new SessionRuntime({
      startupTimeoutMs: 30,
      shutdownGraceMs: 50,
      spawnAppServer: harness.spawnAppServer,
      spawnTui: harness.spawnTui,
      tuiStdio: "ignore",
    });

    await expect(runtime.run()).rejects.toBeInstanceOf(SessionGatewayError);

    expect(runtime.state).toBe("stopped");
    expect(harness.appChildren).toHaveLength(1);
    expect(harness.tuiChildren).toHaveLength(1);
    expect(harness.runtimeDirs).toHaveLength(1);
    const appChild = harness.appChildren[0];
    const tuiChild = harness.tuiChildren[0];
    const runtimeDir = harness.runtimeDirs[0];
    if (appChild === undefined || tuiChild === undefined || runtimeDir === undefined) {
      throw new Error("Expected timeout resources");
    }
    expect(appChild.exitCode !== null || appChild.signalCode !== null).toBe(true);
    expect(tuiChild.exitCode !== null || tuiChild.signalCode !== null).toBe(true);
    await expect(access(runtimeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails when the WebSocket disconnects while the TUI process remains alive", async () => {
    const harness = createRuntimeHarness({ disconnect: true });
    const runtime = new SessionRuntime({
      shutdownGraceMs: 30,
      spawnAppServer: harness.spawnAppServer,
      spawnTui: harness.spawnTui,
      tuiStdio: "ignore",
    });

    await expect(runtime.run()).rejects.toMatchObject({
      name: "SessionGatewayDisconnectedError",
    });

    expect(runtime.state).toBe("stopped");
  });

  it("escalates cleanup to SIGKILL when the App Server ignores SIGTERM", async () => {
    const harness = createRuntimeHarness({
      appScript: IGNORE_SIGTERM_SCRIPT,
      tuiExitCode: 0,
      waitForAppReady: true,
    });
    const runtime = new SessionRuntime({
      shutdownGraceMs: 30,
      spawnAppServer: harness.spawnAppServer,
      spawnTui: harness.spawnTui,
      tuiStdio: "ignore",
    });

    await expect(runtime.run()).resolves.toBe(0);

    expect(harness.appChildren[0]?.signalCode).toBe("SIGKILL");
  });

  it("validates timeouts and idle stop semantics", async () => {
    expect(() => new SessionRuntime({ startupTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new SessionRuntime({ shutdownGraceMs: -1 })).toThrow(RangeError);

    const runtime = new SessionRuntime();
    runtime.requestStop();
    await runtime.stop();
    expect(runtime.state).toBe("idle");
  });

  it("rejects a second run", async () => {
    const harness = createRuntimeHarness({ tuiExitCode: 0 });
    const runtime = new SessionRuntime({
      shutdownGraceMs: 100,
      spawnAppServer: harness.spawnAppServer,
      spawnTui: harness.spawnTui,
      tuiStdio: "ignore",
    });

    await expect(runtime.run()).resolves.toBe(0);
    await expect(runtime.run()).rejects.toThrow("can only run once");
  });
});
