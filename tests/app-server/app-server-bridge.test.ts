import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AppServerBridge,
  AppServerProtocolError,
  AppServerRequestError,
  AppServerTimeoutError,
  type JsonRpcMessage,
} from "../../src/index.js";
import { JsonLinePeer } from "./test-peer.js";

const INITIALIZE_RESULT = {
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex-test",
};

const MODEL = {
  id: "model-a",
  model: "model-a",
  displayName: "Model A",
  description: "Test model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deep" },
  ],
};

type Harness = {
  bridge: AppServerBridge;
  fromServer: PassThrough;
  peer: JsonLinePeer;
};

function createHarness(timeoutMs = 1_000): Harness {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  return {
    bridge: new AppServerBridge(fromServer, toServer, timeoutMs),
    fromServer,
    peer: new JsonLinePeer(toServer),
  };
}

async function initializeHarness(harness: Harness): Promise<void> {
  const initialization = harness.bridge.initialize("0.1.0");
  const request = await harness.peer.next();
  expect(request).toMatchObject({
    method: "initialize",
    params: { capabilities: { experimentalApi: true } },
  });
  JsonLinePeer.write(harness.fromServer, { id: request["id"], result: INITIALIZE_RESULT });
  await expect(harness.peer.next()).resolves.toMatchObject({ method: "initialized" });
  await initialization;
}

describe("AppServerBridge", () => {
  it("completes the internal experimental initialization once", async () => {
    const harness = createHarness();

    await initializeHarness(harness);

    expect(harness.bridge.isInitialized).toBe(true);
    await expect(harness.bridge.initialize("0.1.0")).rejects.toBeInstanceOf(AppServerProtocolError);
    harness.bridge.close();
  });

  it("normalizes and tracks a TUI initialization", async () => {
    const harness = createHarness();
    const clientMessages: JsonRpcMessage[] = [];
    harness.bridge.onClientMessage((message) => clientMessages.push(message));

    await harness.bridge.forwardClientMessage({
      id: 7,
      method: "initialize",
      params: {
        clientInfo: { name: "tui", version: "1" },
        capabilities: { experimentalApi: false, other: true },
      },
    });
    const request = await harness.peer.next();
    expect(request["id"]).not.toBe(7);
    expect(request).toMatchObject({ params: { capabilities: { experimentalApi: true, other: true } } });

    JsonLinePeer.write(harness.fromServer, { id: request["id"], result: INITIALIZE_RESULT });
    expect(clientMessages).toContainEqual({ id: 7, result: INITIALIZE_RESULT });
    expect(harness.bridge.isInitialized).toBe(false);

    await harness.bridge.forwardClientMessage({ method: "initialized" });
    await expect(harness.peer.next()).resolves.toMatchObject({ method: "initialized" });
    expect(harness.bridge.isInitialized).toBe(true);
    harness.bridge.close();
  });

  it("rejects an out-of-sequence TUI initialized notification", async () => {
    const harness = createHarness();

    await expect(harness.bridge.forwardClientMessage({ method: "initialized" })).rejects.toBeInstanceOf(AppServerProtocolError);
    expect(harness.bridge.isInitialized).toBe(false);
    harness.bridge.close();
  });

  it("restores TUI and App Server request identifiers", async () => {
    const harness = createHarness();
    await initializeHarness(harness);
    const clientMessages: JsonRpcMessage[] = [];
    harness.bridge.onClientMessage((message) => clientMessages.push(message));

    await harness.bridge.forwardClientMessage({ id: "client-id", method: "thread/read", params: { threadId: "thread-1" } });
    const clientRequest = await harness.peer.next();
    expect(clientRequest["id"]).not.toBe("client-id");
    JsonLinePeer.write(harness.fromServer, { id: clientRequest["id"], result: { thread: {} } });
    expect(clientMessages.at(-1)).toEqual({ id: "client-id", result: { thread: {} } });

    JsonLinePeer.write(harness.fromServer, { id: 42, method: "item/commandExecution/requestApproval", params: {} });
    const serverRequest = clientMessages.at(-1);
    expect(serverRequest).toMatchObject({ method: "item/commandExecution/requestApproval" });
    if (serverRequest === undefined || !("id" in serverRequest)) {
      throw new Error("Expected proxied server request");
    }
    expect(serverRequest.id).not.toBe(42);
    await harness.bridge.forwardClientMessage({ id: serverRequest.id, result: { decision: "accept" } });
    await expect(harness.peer.next()).resolves.toEqual({ id: 42, result: { decision: "accept" } });
    harness.bridge.close();
  });

  it("paginates and validates the model catalog", async () => {
    const harness = createHarness();
    await initializeHarness(harness);

    const listing = harness.bridge.listModels();
    const first = await harness.peer.next();
    expect(first).toMatchObject({ method: "model/list", params: {} });
    JsonLinePeer.write(harness.fromServer, { id: first["id"], result: { data: [MODEL], nextCursor: "page-2" } });
    const second = await harness.peer.next();
    expect(second).toMatchObject({ method: "model/list", params: { cursor: "page-2" } });
    JsonLinePeer.write(harness.fromServer, { id: second["id"], result: { data: [{ ...MODEL, id: "model-b", model: "model-b" }], nextCursor: null } });

    await expect(listing).resolves.toHaveLength(2);
    harness.bridge.close();
  });

  it("forwards notifications to controller and TUI listeners", async () => {
    const harness = createHarness();
    await initializeHarness(harness);
    const notifications: JsonRpcMessage[] = [];
    const clientMessages: JsonRpcMessage[] = [];
    harness.bridge.onNotification((message) => notifications.push(message));
    harness.bridge.onClientMessage((message) => clientMessages.push(message));
    const notification = {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    };

    JsonLinePeer.write(harness.fromServer, notification);

    expect(notifications).toContainEqual(notification);
    expect(clientMessages).toContainEqual(notification);
    harness.bridge.close();
  });

  it("sends settings and starts a typed turn", async () => {
    const harness = createHarness();
    await initializeHarness(harness);

    const updating = harness.bridge.updateThreadSettings({ threadId: "thread-1", model: "model-a", effort: "high" });
    const updateRequest = await harness.peer.next();
    expect(updateRequest).toMatchObject({ method: "thread/settings/update" });
    JsonLinePeer.write(harness.fromServer, { id: updateRequest["id"], result: {} });
    await updating;

    const starting = harness.bridge.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "continue" }],
      model: "model-a",
      effort: "high",
    });
    const startRequest = await harness.peer.next();
    expect(startRequest).toMatchObject({ method: "turn/start" });
    JsonLinePeer.write(harness.fromServer, {
      id: startRequest["id"],
      result: { turn: { id: "turn-2", status: "inProgress", items: [] } },
    });

    await expect(starting).resolves.toMatchObject({ id: "turn-2", status: "inProgress" });
    harness.bridge.close();
  });

  it("rejects application methods before initialization", async () => {
    const harness = createHarness();

    await expect(harness.bridge.listModels()).rejects.toBeInstanceOf(AppServerProtocolError);
    await expect(harness.bridge.updateThreadSettings({ threadId: "thread-1" })).rejects.toBeInstanceOf(AppServerProtocolError);
    await expect(harness.bridge.startTurn({ threadId: "thread-1", input: [] })).rejects.toBeInstanceOf(AppServerProtocolError);
    harness.bridge.close();
  });

  it("maps remote errors without hiding their code", async () => {
    const harness = createHarness();
    await initializeHarness(harness);
    const listing = harness.bridge.listModels();
    const request = await harness.peer.next();

    JsonLinePeer.write(harness.fromServer, { id: request["id"], error: { code: -32601, message: "Unknown method", data: { method: "model/list" } } });

    await expect(listing).rejects.toBeInstanceOf(AppServerRequestError);
    await expect(listing).rejects.toMatchObject({
      name: "AppServerRequestError",
      code: -32601,
      data: { method: "model/list" },
    });
    harness.bridge.close();
  });

  it("closes on timeout and invalid response payloads", async () => {
    const timeoutHarness = createHarness(20);
    await initializeHarness(timeoutHarness);
    const timeoutClose = new Promise<Error>((resolve) => timeoutHarness.bridge.onClose(resolve));
    const timeoutListing = timeoutHarness.bridge.listModels();
    await timeoutHarness.peer.next();
    await expect(timeoutListing).rejects.toBeInstanceOf(AppServerTimeoutError);
    await expect(timeoutClose).resolves.toBeInstanceOf(AppServerTimeoutError);

    const invalidHarness = createHarness();
    await initializeHarness(invalidHarness);
    const invalidListing = invalidHarness.bridge.listModels();
    const request = await invalidHarness.peer.next();
    JsonLinePeer.write(invalidHarness.fromServer, { id: request["id"], result: { data: [{}], nextCursor: null } });
    await expect(invalidListing).rejects.toBeInstanceOf(AppServerProtocolError);
  });

  it("closes on repeated pagination cursors and unmatched responses", async () => {
    const paginationHarness = createHarness();
    await initializeHarness(paginationHarness);
    const listing = paginationHarness.bridge.listModels();
    const first = await paginationHarness.peer.next();
    JsonLinePeer.write(paginationHarness.fromServer, { id: first["id"], result: { data: [], nextCursor: "same" } });
    const second = await paginationHarness.peer.next();
    JsonLinePeer.write(paginationHarness.fromServer, { id: second["id"], result: { data: [], nextCursor: "same" } });
    await expect(listing).rejects.toBeInstanceOf(AppServerProtocolError);

    const unmatchedHarness = createHarness();
    const unmatchedClose = new Promise<Error>((resolve) => unmatchedHarness.bridge.onClose(resolve));
    JsonLinePeer.write(unmatchedHarness.fromServer, { id: "unknown", result: {} });
    await expect(unmatchedClose).resolves.toBeInstanceOf(AppServerProtocolError);
  });
});
