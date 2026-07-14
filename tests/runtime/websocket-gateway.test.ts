import { PassThrough } from "node:stream";

import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";

import {
  AppServerBridge,
  SessionGatewayError,
  WebSocketGateway,
  type JsonRpcMessage,
} from "../../src/index.js";
import { JsonLinePeer } from "../app-server/test-peer.js";

const AUTH_TOKEN = "a".repeat(32);

type GatewayHarness = {
  bridge: AppServerBridge;
  fromServer: PassThrough;
  gateway: WebSocketGateway;
  peer: JsonLinePeer;
  fatalErrors: Error[];
};

function createHarness(): GatewayHarness {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const bridge = new AppServerBridge(fromServer, toServer);
  const fatalErrors: Error[] = [];
  return {
    bridge,
    fromServer,
    gateway: new WebSocketGateway(bridge, AUTH_TOKEN, (error) => fatalErrors.push(error)),
    peer: new JsonLinePeer(toServer),
    fatalErrors,
  };
}

function connect(address: string, token = AUTH_TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address, {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => {
      if (isBinary) {
        reject(new TypeError("Expected a text WebSocket message"));
        return;
      }
      try {
        resolve(JSON.parse(data.toString()) as JsonRpcMessage);
      } catch (error) {
        reject(error);
      }
    });
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

describe("WebSocketGateway", () => {
  it("requires a sufficiently strong token and a started gateway", async () => {
    const harness = createHarness();

    expect(() => new WebSocketGateway(harness.bridge, "short", () => undefined)).toThrow(RangeError);
    await expect(harness.gateway.waitForClient(20)).rejects.toThrow("has not started");
    await expect(harness.gateway.waitForClient(0)).rejects.toBeInstanceOf(RangeError);
    harness.bridge.close();
  });

  it("rejects missing and invalid bearer credentials", async () => {
    const harness = createHarness();
    const address = await harness.gateway.start();

    await expect(connect(address, "b".repeat(32))).rejects.toThrow();
    await expect(new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(address);
      socket.once("open", () => reject(new Error("Unauthenticated socket opened")));
      socket.once("error", () => resolve());
    })).resolves.toBeUndefined();

    await harness.gateway.close();
    harness.bridge.close();
    expect(harness.fatalErrors).toEqual([]);
  });

  it("proxies requests, responses, and notifications in both directions", async () => {
    const harness = createHarness();
    const bridgeNotifications: JsonRpcMessage[] = [];
    harness.bridge.onNotification((notification) => bridgeNotifications.push(notification));
    const address = await within(harness.gateway.start(), "starting gateway");
    const socket = await within(connect(address), "connecting client");
    await within(harness.gateway.waitForClient(100), "confirming client connection");

    socket.send(JSON.stringify({ id: 7, method: "thread/read", params: { threadId: "thread-1" } }));
    const request = await within(harness.peer.next(), "receiving proxied request");
    expect(request).toMatchObject({ method: "thread/read", params: { threadId: "thread-1" } });
    expect(request["id"]).not.toBe(7);

    const responseMessage = nextMessage(socket);
    JsonLinePeer.write(harness.fromServer, { id: request["id"], result: { thread: { id: "thread-1" } } });
    await expect(within(responseMessage, "receiving proxied response")).resolves.toEqual({ id: 7, result: { thread: { id: "thread-1" } } });

    const notificationMessage = nextMessage(socket);
    JsonLinePeer.write(harness.fromServer, { method: "turn/started", params: { threadId: "thread-1" } });
    await expect.poll(() => bridgeNotifications.length).toBe(1);
    expect(harness.fatalErrors).toEqual([]);
    await expect(within(notificationMessage, "receiving proxied notification")).resolves.toEqual({ method: "turn/started", params: { threadId: "thread-1" } });

    await within(harness.gateway.close(), "closing gateway");
    await within(harness.gateway.close(), "confirming idempotent close");
    harness.bridge.close();
    expect(harness.fatalErrors).toEqual([]);
  });

  it("times out while waiting for a TUI client", async () => {
    const harness = createHarness();
    await harness.gateway.start();

    await expect(harness.gateway.waitForClient(20)).rejects.toThrow("within 20 ms");

    await harness.gateway.close();
    harness.bridge.close();
  });

  it("fails the session on binary input", async () => {
    const harness = createHarness();
    const address = await harness.gateway.start();
    const socket = await connect(address);
    socket.send(Buffer.from([1, 2, 3]));

    await expect.poll(() => harness.fatalErrors.length).toBe(1);
    expect(harness.fatalErrors[0]).toBeInstanceOf(SessionGatewayError);
    expect(harness.fatalErrors[0]?.message).toContain("Invalid TUI WebSocket message");

    await harness.gateway.close();
    harness.bridge.close();
  });
});
