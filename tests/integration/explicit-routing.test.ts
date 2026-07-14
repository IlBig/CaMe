import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";

import {
  AppServerBridge,
  GovernanceController,
  HandoffEngine,
  WebSocketGateway,
  type AuditEventInput,
  type AuditSink,
  type CodexModel,
  type ControlPlaneRequestContext,
  type JsonRpcMessage,
} from "../../src/index.js";
import { JsonLinePeer } from "../app-server/test-peer.js";

const AUTH_TOKEN = "a".repeat(32);
const TARGET_MODEL: CodexModel = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: "Integration target",
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "Deep" },
    { reasoningEffort: "ultra", description: "Deeper" },
  ],
};

class MemoryAuditSink implements AuditSink {
  public readonly events: AuditEventInput[] = [];

  public async record(event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

function context(): ControlPlaneRequestContext {
  return { requestId: randomUUID(), signal: new AbortController().signal };
}

function connect(address: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<JsonRpcMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: JsonRpcMessage[] = [];
    const onMessage = (data: Buffer, isBinary: boolean): void => {
      if (isBinary) {
        cleanup();
        reject(new TypeError("Expected a text WebSocket message"));
        return;
      }
      try {
        messages.push(JSON.parse(data.toString()) as JsonRpcMessage);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (messages.length === count) {
        cleanup();
        resolve(messages);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out while ${label}`)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("CaMe explicit routing integration", () => {
  it("updates settings and completes the authenticated TUI request without an App Server turn", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const bridge = new AppServerBridge(fromServer, toServer, 1_000);
    const peer = new JsonLinePeer(toServer);
    const initializing = bridge.initialize("0.1.0");
    const initializeRequest = await peer.next();
    JsonLinePeer.write(fromServer, {
      id: initializeRequest["id"],
      result: {
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "came-explicit-integration-test",
      },
    });
    await expect(peer.next()).resolves.toMatchObject({ method: "initialized" });
    await initializing;

    const sessionId = randomUUID();
    const audit = new MemoryAuditSink();
    const fatalErrors: Error[] = [];
    const handoff = new HandoffEngine({
      sessionId,
      bridge,
      governance: new GovernanceController({ sessionId, auditSink: audit }),
      onFatalError: (error) => fatalErrors.push(error),
    });
    const gateway = new WebSocketGateway(
      bridge,
      AUTH_TOKEN,
      (error) => fatalErrors.push(error),
      (request) => handoff.applyExplicitProfile(request),
    );
    let socket: WebSocket | null = null;
    try {
      JsonLinePeer.write(fromServer, {
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          threadSettings: { model: "gpt-5.5", effort: "xhigh" },
        },
      });
      await expect(handoff.getState(context())).resolves.toMatchObject({
        activeThreadId: "thread-1",
        activeTurnId: null,
      });

      socket = await connect(await gateway.start());
      const messagesPromise = nextMessages(socket, 6);
      const command = "cambia modello in 5.6 sol ultra";
      socket.send(JSON.stringify({
        id: 71,
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: command, text_elements: [] }],
          model: "gpt-5.5",
          effort: "xhigh",
        },
      }));

      const modelRequest = await within(peer.next(), "receiving explicit model list request");
      expect(modelRequest).toMatchObject({ method: "model/list", params: {} });
      JsonLinePeer.write(fromServer, {
        id: modelRequest["id"],
        result: { data: [TARGET_MODEL], nextCursor: null },
      });
      const settingsRequest = await within(peer.next(), "receiving explicit settings update");
      expect(settingsRequest).toMatchObject({
        method: "thread/settings/update",
        params: { threadId: "thread-1", model: TARGET_MODEL.model, effort: "ultra" },
      });
      JsonLinePeer.write(fromServer, {
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          threadSettings: { model: TARGET_MODEL.model, effort: "ultra" },
        },
      });
      JsonLinePeer.write(fromServer, { id: settingsRequest["id"], result: {} });

      const messages = await within(messagesPromise, "receiving explicit TUI completion");
      expect(messages.map((message) => "method" in message ? message.method : "response")).toEqual([
        "thread/settings/updated",
        "response",
        "turn/started",
        "item/started",
        "item/completed",
        "turn/completed",
      ]);
      expect(messages).toContainEqual(expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({ text: "Profilo attivo: gpt-5.6-sol/ultra." }),
        }),
      }));
      expect(JSON.stringify(messages)).not.toContain(command);

      socket.send(JSON.stringify({ id: 72, method: "thread/read", params: { threadId: "thread-1" } }));
      const followingRequest = await within(peer.next(), "checking absence of an App Server turn");
      expect(followingRequest).toMatchObject({ method: "thread/read" });
      JsonLinePeer.write(fromServer, { id: followingRequest["id"], result: { thread: { id: "thread-1" } } });

      await expect(handoff.getState(context())).resolves.toMatchObject({
        activeThreadId: "thread-1",
        activeTurnId: null,
        currentProfile: { model: TARGET_MODEL.model, effort: "ultra" },
        routerState: "idle",
      });
      expect(audit.events.map((event) => event.event)).toEqual([
        "switch_requested",
        "switch_scheduled",
        "settings_applied",
      ]);
      expect(fatalErrors).toEqual([]);
    } finally {
      await gateway.close();
      handoff.close();
      bridge.close();
    }
  });
});
