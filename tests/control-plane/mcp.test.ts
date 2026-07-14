import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  ControlMcpConfigurationError,
  ControlPlaneClient,
  ControlPlaneServer,
  AUTONOMOUS_SWITCH_CONTINUATION,
  AUTONOMOUS_SWITCH_REASON,
  createControlMcpServer,
  runControlMcpServer,
  type ControlPlaneHandler,
  type SessionState,
  type SwitchRequest,
} from "../../src/index.js";

const AUTH_TOKEN = "a".repeat(43);

function createState(sessionId: string): SessionState {
  return {
    sessionId,
    activeThreadId: "thread-1",
    activeTurnId: "turn-1",
    currentProfile: { model: "gpt-test", effort: "high" },
    chainId: randomUUID(),
    autonomousSwitches: 1,
    routerState: "waiting_turn_completion",
  };
}

describe("CaMe MCP control server", () => {
  it("lists and invokes all tools end-to-end through authenticated IPC", async () => {
    const directory = await mkdtemp(join(tmpdir(), "came-mcp-test-"));
    await chmod(directory, 0o700);
    const socketPath = join(directory, "control.sock");
    const sessionId = randomUUID();
    let switchRequest: SwitchRequest | null = null;
    const handler: ControlPlaneHandler = {
      switchModel: async (request) => {
        switchRequest = request;
        return { status: "scheduled", switchId: randomUUID() };
      },
      confirmSwitch: async () => ({ status: "noop" }),
      getState: async () => createState(sessionId),
    };
    const controlServer = new ControlPlaneServer({ socketPath, sessionId, authToken: AUTH_TOKEN, handler });
    await controlServer.start();
    const mcpServer = createControlMcpServer(new ControlPlaneClient({ socketPath, sessionId, authToken: AUTH_TOKEN }));
    const client = new Client({ name: "came-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "came_confirm_switch",
        "came_session_state",
        "came_switch_model",
      ]);
      const switchTool = tools.tools.find((tool) => tool.name === "came_switch_model");
      expect(switchTool?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["model", "effort"],
        properties: {
          model: expect.any(Object),
          effort: expect.any(Object),
        },
      });
      expect(Object.keys(switchTool?.inputSchema.properties ?? {})).toEqual(["model", "effort"]);

      const switchResult = await client.callTool({
        name: "came_switch_model",
        arguments: {
          model: "gpt-test-2",
          effort: "xhigh",
        },
      });
      expect(switchResult.isError, JSON.stringify(switchResult)).not.toBe(true);
      expect(switchResult.structuredContent).toMatchObject({ status: "scheduled" });
      expect(switchRequest).toEqual({
        model: "gpt-test-2",
        effort: "xhigh",
        reason: AUTONOMOUS_SWITCH_REASON,
        continuation: AUTONOMOUS_SWITCH_CONTINUATION,
      });

      const confirmResult = await client.callTool({
        name: "came_confirm_switch",
        arguments: { requestId: randomUUID() },
      });
      expect(confirmResult.structuredContent).toEqual({ status: "noop" });

      const stateResult = await client.callTool({ name: "came_session_state", arguments: {} });
      expect(stateResult.structuredContent).toMatchObject({ sessionId, activeThreadId: "thread-1" });
    } finally {
      await client.close();
      await mcpServer.close();
      await controlServer.close();
      await rm(directory, { recursive: true, force: false });
    }
  });

  it("rejects invalid tool input before IPC execution", async () => {
    const client = new Client({ name: "came-validation-test", version: "0.1.0" });
    const controlClient = new ControlPlaneClient({
      socketPath: "/tmp/does-not-exist.sock",
      sessionId: randomUUID(),
      authToken: AUTH_TOKEN,
    });
    const mcpServer = createControlMcpServer(controlClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "came_switch_model",
        arguments: { model: "gpt-test" },
      });

      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("rejects agent-controlled routing context before IPC execution", async () => {
    const client = new Client({ name: "came-strict-input-test", version: "0.1.0" });
    const controlClient = new ControlPlaneClient({
      socketPath: "/tmp/does-not-exist.sock",
      sessionId: randomUUID(),
      authToken: AUTH_TOKEN,
    });
    const mcpServer = createControlMcpServer(controlClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "came_switch_model",
        arguments: {
          model: "gpt-test",
          effort: "high",
          reason: "agent supplied",
          continuation: "agent supplied",
        },
      });

      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("fails explicitly when the session environment is absent", async () => {
    await expect(runControlMcpServer({}, process.stdin, process.stdout)).rejects.toBeInstanceOf(ControlMcpConfigurationError);
  });
});
