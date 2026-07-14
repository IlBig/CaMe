import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTROL_PROTOCOL_VERSION,
  ControlPlaneClient,
  ControlPlaneClientError,
  ControlPlaneRemoteError,
  ControlPlaneServer,
  type ControlPlaneHandler,
  type ControlPlaneRequestContext,
  type ControlResponse,
  type SessionState,
  type SwitchRequest,
  type SwitchResult,
} from "../../src/index.js";

const AUTH_TOKEN = "a".repeat(43);
const OTHER_TOKEN = "b".repeat(43);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type Harness = {
  client: ControlPlaneClient;
  directory: string;
  handler: TestHandler;
  server: ControlPlaneServer;
  sessionId: string;
  socketPath: string;
};

class TestHandler implements ControlPlaneHandler {
  public readonly calls: string[] = [];

  public async switchModel(_request: SwitchRequest, _context: ControlPlaneRequestContext): Promise<SwitchResult> {
    this.calls.push("switch");
    return { status: "scheduled", switchId: randomUUID() };
  }

  public async confirmSwitch(_request: { requestId: string }, _context: ControlPlaneRequestContext): Promise<SwitchResult> {
    this.calls.push("confirm");
    return { status: "noop" };
  }

  public async getState(_context: ControlPlaneRequestContext): Promise<SessionState> {
    this.calls.push("state");
    return createState();
  }
}

function createState(): SessionState {
  return {
    sessionId: randomUUID(),
    activeThreadId: null,
    activeTurnId: null,
    currentProfile: null,
    chainId: null,
    autonomousSwitches: 0,
    routerState: "idle",
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Could not create deferred test value");
  }
  return { promise, resolve: resolvePromise };
}

async function createHarness(serverOptions: Partial<{
  requestTimeoutMs: number;
  maxMessageBytes: number;
  maxConnections: number;
  replayTtlMs: number;
  maxReplayEntries: number;
}> = {}, handler: ControlPlaneHandler = new TestHandler()): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "came-control-test-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "control.sock");
  const sessionId = randomUUID();
  const server = new ControlPlaneServer({
    socketPath,
    sessionId,
    authToken: AUTH_TOKEN,
    handler,
    ...serverOptions,
  });
  await server.start();
  return {
    client: new ControlPlaneClient({ socketPath, sessionId, authToken: AUTH_TOKEN, requestTimeoutMs: 500 }),
    directory,
    handler: handler as TestHandler,
    server,
    sessionId,
    socketPath,
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.server.close();
  await rm(harness.directory, { recursive: true, force: false });
}

function sendRaw(socketPath: string, value: unknown, suffix = "\n"): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("Timed out waiting for raw control response"));
      }
    }, 500);
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    };
    socket.once("connect", () => socket.write(`${typeof value === "string" ? value : JSON.stringify(value)}${suffix}`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) {
        fail(new Error("Control socket closed without a complete response"));
      }
    });
  });
}

function rawStateRequest(sessionId: string, token = AUTH_TOKEN, requestId = randomUUID()): Record<string, unknown> {
  return {
    version: CONTROL_PROTOCOL_VERSION,
    requestId,
    sessionId,
    token,
    method: "state",
    params: {},
  };
}

function openSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out while ${label}`)), 500);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("control plane IPC", () => {
  it("routes typed client calls serially through a restricted Unix socket", async () => {
    const harness = await createHarness();
    try {
      expect((await stat(harness.socketPath)).mode & 0o777).toBe(0o600);

      await expect(harness.client.switchModel({
        model: "gpt-test",
        effort: "high",
        reason: "The task needs more reasoning",
        continuation: "Continue implementation",
      })).resolves.toMatchObject({ status: "scheduled" });
      await expect(harness.client.confirmSwitch({ requestId: randomUUID() })).resolves.toEqual({ status: "noop" });
      await expect(harness.client.getState()).resolves.toMatchObject({ routerState: "idle" });

      expect(harness.handler.calls).toEqual(["switch", "confirm", "state"]);
    } finally {
      await closeHarness(harness);
    }
    await expect(stat(harness.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid authentication and cross-session requests before the handler", async () => {
    const harness = await createHarness();
    try {
      const invalidAuth = await sendRaw(harness.socketPath, rawStateRequest(harness.sessionId, OTHER_TOKEN));
      expect(invalidAuth).toMatchObject({ ok: false, error: { code: "authentication_failed" } });

      const otherSession = await sendRaw(harness.socketPath, rawStateRequest(randomUUID()));
      expect(otherSession).toMatchObject({ ok: false, error: { code: "session_mismatch" } });
      expect(harness.handler.calls).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("rejects replayed request identifiers", async () => {
    const harness = await createHarness();
    try {
      const requestId = randomUUID();
      const request = rawStateRequest(harness.sessionId, AUTH_TOKEN, requestId);

      expect(await sendRaw(harness.socketPath, request)).toMatchObject({ requestId, ok: true });
      expect(await sendRaw(harness.socketPath, request)).toMatchObject({
        requestId,
        ok: false,
        error: { code: "replay_detected" },
      });
      expect(harness.handler.calls).toEqual(["state"]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("serializes concurrent handler execution", async () => {
    const releaseSwitch = createDeferred<SwitchResult>();
    const calls: string[] = [];
    const handler: ControlPlaneHandler = {
      switchModel: async () => {
        calls.push("switch:start");
        const result = await releaseSwitch.promise;
        calls.push("switch:end");
        return result;
      },
      confirmSwitch: async () => ({ status: "noop" }),
      getState: async () => {
        calls.push("state");
        return createState();
      },
    };
    const harness = await createHarness({}, handler);
    try {
      const switching = harness.client.switchModel({
        model: "gpt-test",
        effort: "high",
        reason: "Need more reasoning",
        continuation: "Continue",
      });
      await expect.poll(() => calls).toEqual(["switch:start"]);
      const reading = harness.client.getState();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual(["switch:start"]);

      releaseSwitch.resolve({ status: "noop" });
      await expect(switching).resolves.toEqual({ status: "noop" });
      await expect(reading).resolves.toMatchObject({ routerState: "idle" });
      expect(calls).toEqual(["switch:start", "switch:end", "state"]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("aborts and reports a timed-out handler without leaking its error", async () => {
    const observedAbort = createDeferred<void>();
    const handler: ControlPlaneHandler = {
      switchModel: async () => ({ status: "noop" }),
      confirmSwitch: async () => ({ status: "noop" }),
      getState: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort.resolve(undefined);
          reject(new Error("sensitive handler detail"));
        }, { once: true });
      }),
    };
    const harness = await createHarness({ requestTimeoutMs: 30 }, handler);
    const client = new ControlPlaneClient({
      socketPath: harness.socketPath,
      sessionId: harness.sessionId,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 500,
    });
    try {
      const error = await client.getState().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ControlPlaneRemoteError);
      expect(error).toMatchObject({ code: "request_timeout" });
      expect((error as Error).message).not.toContain("sensitive");
      await expect(observedAbort.promise).resolves.toBeUndefined();
    } finally {
      await closeHarness(harness);
    }
  });

  it("bounds invalid messages and replay capacity", async () => {
    const harness = await createHarness({ maxMessageBytes: 300, maxReplayEntries: 1 });
    try {
      const first = rawStateRequest(harness.sessionId);
      expect(await sendRaw(harness.socketPath, first)).toMatchObject({ ok: true });
      expect(await sendRaw(harness.socketPath, rawStateRequest(harness.sessionId))).toMatchObject({
        ok: false,
        error: { code: "capacity_exceeded" },
      });
      expect(await sendRaw(harness.socketPath, "x".repeat(301))).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("rejects connections above the configured capacity", async () => {
    const harness = await createHarness({ maxConnections: 1 });
    const occupied = await within(openSocket(harness.socketPath), "occupying control connection");
    try {
      expect(await within(
        sendRaw(harness.socketPath, rawStateRequest(harness.sessionId)),
        "receiving capacity response",
      )).toMatchObject({
        requestId: null,
        ok: false,
        error: { code: "capacity_exceeded" },
      });
      expect(harness.handler.calls).toEqual([]);
    } finally {
      occupied.destroy();
      await within(closeHarness(harness), "closing capacity harness");
    }
  });

  it("propagates client cancellation to the active handler", async () => {
    const handlerStarted = createDeferred<void>();
    const handlerAborted = createDeferred<void>();
    const handler: ControlPlaneHandler = {
      switchModel: async () => ({ status: "noop" }),
      confirmSwitch: async () => ({ status: "noop" }),
      getState: async ({ signal }) => new Promise((_resolve, reject) => {
        handlerStarted.resolve(undefined);
        signal.addEventListener("abort", () => {
          handlerAborted.resolve(undefined);
          reject(signal.reason);
        }, { once: true });
      }),
    };
    const harness = await createHarness({ requestTimeoutMs: 500 }, handler);
    const controller = new AbortController();
    try {
      const reading = harness.client.getState(controller.signal);
      await handlerStarted.promise;
      controller.abort(new Error("cancel test"));

      await expect(reading).rejects.toBeInstanceOf(ControlPlaneClientError);
      await expect(handlerAborted.promise).resolves.toBeUndefined();
    } finally {
      await closeHarness(harness);
    }
  });

  it("does not remove an unowned socket path when closed before startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "came-control-unowned-"));
    const socketPath = join(directory, "control.sock");
    await writeFile(socketPath, "sentinel");
    const server = new ControlPlaneServer({
      socketPath,
      sessionId: randomUUID(),
      authToken: AUTH_TOKEN,
      handler: new TestHandler(),
    });

    try {
      await server.close();
      await expect(stat(socketPath)).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: false });
    }
  });

  it("validates paths, credentials, and timeout options", () => {
    const handler = new TestHandler();
    expect(() => new ControlPlaneServer({
      socketPath: "relative.sock",
      sessionId: randomUUID(),
      authToken: AUTH_TOKEN,
      handler,
    })).toThrow(RangeError);
    expect(() => new ControlPlaneClient({
      socketPath: "/tmp/control.sock",
      sessionId: randomUUID(),
      authToken: "short",
    })).toThrow();
    expect(() => new ControlPlaneClient({
      socketPath: "/tmp/control.sock",
      sessionId: randomUUID(),
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 0,
    })).toThrow(RangeError);
  });
});
