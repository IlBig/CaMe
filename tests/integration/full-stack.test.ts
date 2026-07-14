import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  AppServerBridge,
  AUTONOMOUS_SWITCH_CONTINUATION,
  AUTONOMOUS_SWITCH_REASON,
  ControlPlaneClient,
  ControlPlaneServer,
  GovernanceController,
  HandoffEngine,
  JsonlAuditLog,
  createControlMcpServer,
  type CodexModel,
} from "../../src/index.js";
import { JsonLinePeer } from "../app-server/test-peer.js";

const AUTH_TOKEN = "a".repeat(43);
const INVALID_AUTH_TOKEN = "b".repeat(43);
const INITIAL_PROFILE = { model: "model-a", effort: "medium" };
const TARGET_MODEL: CodexModel = {
  id: "model-b-id",
  model: "model-b",
  displayName: "Model B",
  description: "Integration target",
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "Deep" },
    { reasoningEffort: "xhigh", description: "Deeper" },
  ],
};
const SWITCH_ARGUMENTS = {
  model: TARGET_MODEL.id,
  effort: "xhigh",
};

type FullStackHarness = {
  audit: JsonlAuditLog;
  auditPath: string;
  bridge: AppServerBridge;
  client: Client;
  controlServer: ControlPlaneServer;
  directory: string;
  fatalErrors: Error[];
  fromServer: PassThrough;
  handoff: HandoffEngine;
  mcpServer: ReturnType<typeof createControlMcpServer>;
  peer: JsonLinePeer;
  sessionId: string;
  socketPath: string;
};

async function createHarness(mcpAuthToken = AUTH_TOKEN): Promise<FullStackHarness> {
  const directory = await mkdtemp(join(tmpdir(), "came-integration-test-"));
  await chmod(directory, 0o700);
  const auditPath = join(directory, "audit.jsonl");
  const socketPath = join(directory, "control.sock");
  const sessionId = randomUUID();
  const audit = await JsonlAuditLog.create(auditPath, sessionId);
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
      userAgent: "came-integration-test",
    },
  });
  await expect(peer.next()).resolves.toMatchObject({ method: "initialized" });
  await initializing;

  const fatalErrors: Error[] = [];
  const handoff = new HandoffEngine({
    sessionId,
    bridge,
    governance: new GovernanceController({ sessionId, auditSink: audit }),
    onFatalError: (error) => fatalErrors.push(error),
  });
  const controlServer = new ControlPlaneServer({
    socketPath,
    sessionId,
    authToken: AUTH_TOKEN,
    handler: handoff,
    requestTimeoutMs: 1_000,
  });
  await controlServer.start();
  const mcpServer = createControlMcpServer(new ControlPlaneClient({
    socketPath,
    sessionId,
    authToken: mcpAuthToken,
    requestTimeoutMs: 1_000,
  }));
  const client = new Client({ name: "came-integration-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    audit,
    auditPath,
    bridge,
    client,
    controlServer,
    directory,
    fatalErrors,
    fromServer,
    handoff,
    mcpServer,
    peer,
    sessionId,
    socketPath,
  };
}

async function activateTurn(harness: FullStackHarness): Promise<void> {
  JsonLinePeer.write(harness.fromServer, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: INITIAL_PROFILE },
  });
  JsonLinePeer.write(harness.fromServer, {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
  });
  const state = await harness.client.callTool({ name: "came_session_state", arguments: {} });
  expect(state.structuredContent).toMatchObject({
    activeThreadId: "thread-1",
    activeTurnId: "turn-1",
    currentProfile: INITIAL_PROFILE,
  });
}

async function closeHarness(harness: FullStackHarness): Promise<void> {
  await harness.client.close();
  await harness.mcpServer.close();
  await harness.controlServer.close();
  harness.handoff.close();
  await harness.audit.close();
  harness.bridge.close();
  await rm(harness.directory, { recursive: true, force: false });
}

describe("CaMe integrated stack", () => {
  it("routes an MCP switch through authenticated IPC and resumes the same App Server thread", async () => {
    const harness = await createHarness();
    try {
      await activateTurn(harness);
      expect((await stat(harness.socketPath)).mode & 0o777).toBe(0o600);

      const switching = harness.client.callTool({
        name: "came_switch_model",
        arguments: SWITCH_ARGUMENTS,
      });
      const modelRequest = await harness.peer.next();
      expect(modelRequest).toMatchObject({ method: "model/list", params: {} });
      JsonLinePeer.write(harness.fromServer, {
        id: modelRequest["id"],
        result: { data: [TARGET_MODEL], nextCursor: null },
      });
      const switchResult = await switching;
      expect(switchResult.isError, JSON.stringify(switchResult)).not.toBe(true);
      expect(switchResult.structuredContent).toMatchObject({ status: "scheduled" });

      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });
      const updateRequest = await harness.peer.next();
      expect(updateRequest).toMatchObject({
        method: "thread/settings/update",
        params: { threadId: "thread-1", model: TARGET_MODEL.model, effort: "xhigh" },
      });
      JsonLinePeer.write(harness.fromServer, { id: updateRequest["id"], result: {} });

      const continuationRequest = await harness.peer.next();
      expect(continuationRequest).toMatchObject({
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: AUTONOMOUS_SWITCH_CONTINUATION }],
          model: TARGET_MODEL.model,
          effort: "xhigh",
        },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        id: continuationRequest["id"],
        result: { turn: { id: "turn-2", status: "inProgress", items: [] } },
      });

      const state = await harness.client.callTool({ name: "came_session_state", arguments: {} });
      expect(state.structuredContent).toMatchObject({
        sessionId: harness.sessionId,
        activeThreadId: "thread-1",
        activeTurnId: "turn-2",
        currentProfile: { model: TARGET_MODEL.model, effort: "xhigh" },
        autonomousSwitches: 1,
        routerState: "idle",
      });
      await harness.audit.close();
      const auditText = await readFile(harness.auditPath, "utf8");
      const auditEvents = auditText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(auditEvents.map((event) => event["event"])).toEqual([
        "switch_requested",
        "switch_scheduled",
        "settings_applied",
        "continuation_started",
      ]);
      expect(auditText).not.toContain(AUTONOMOUS_SWITCH_REASON);
      expect(auditText).not.toContain(AUTONOMOUS_SWITCH_CONTINUATION);
      expect((await stat(harness.auditPath)).mode & 0o777).toBe(0o600);
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("rejects an invalid MCP control token before handoff or audit execution", async () => {
    const harness = await createHarness(INVALID_AUTH_TOKEN);
    try {
      JsonLinePeer.write(harness.fromServer, {
        method: "thread/settings/updated",
        params: { threadId: "thread-1", threadSettings: INITIAL_PROFILE },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
      });
      const result = await harness.client.callTool({ name: "came_session_state", arguments: {} });

      expect(result.isError).toBe(true);
      expect(await readFile(harness.auditPath, "utf8")).toBe("");
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });
});
