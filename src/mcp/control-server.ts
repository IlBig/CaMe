import type { Readable, Writable } from "node:stream";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  confirmSwitchRequestSchema,
  sessionStateSchema,
  switchRequestSchema,
  switchResultSchema,
} from "../contracts.js";
import { ControlPlaneClient } from "../control-plane/ipc-client.js";
import {
  CAME_CONTROL_SOCKET_ENV,
  CAME_CONTROL_TOKEN_ENV,
} from "../control-plane/protocol.js";
import { CAME_SESSION_ID_ENV } from "../runtime/session-runtime.js";

export const CONTROL_MCP_SERVER_NAME = "came-control";
export const CONTROL_MCP_SERVER_VERSION = "0.1.0";

const switchToolOutputSchema = z.object({
  status: z.enum(["scheduled", "confirmation_required", "noop", "rejected"]),
  switchId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  code: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
}).strict().superRefine((result, context) => {
  if (!switchResultSchema.safeParse(result).success) {
    context.addIssue({
      code: "custom",
      message: "Invalid switch result variant",
    });
  }
});

export function createControlMcpServer(client: ControlPlaneClient): McpServer {
  const server = new McpServer({
    name: CONTROL_MCP_SERVER_NAME,
    version: CONTROL_MCP_SERVER_VERSION,
  });

  server.registerTool("came_switch_model", {
    title: "Schedule CaMe model switch",
    description: "Schedule an autonomous model and reasoning-effort handoff in the current Codex thread.",
    inputSchema: switchRequestSchema,
    outputSchema: switchToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (request, extra) => formatToolResult(await client.switchModel(request, extra.signal)));

  server.registerTool("came_confirm_switch", {
    title: "Confirm CaMe model switch",
    description: "Consume a pending one-time confirmation for a model and reasoning-effort handoff.",
    inputSchema: confirmSwitchRequestSchema,
    outputSchema: switchToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (request, extra) => formatToolResult(await client.confirmSwitch(request, extra.signal)));

  server.registerTool("came_session_state", {
    title: "Read CaMe session state",
    description: "Read the current CaMe routing and handoff state for this Codex session.",
    inputSchema: z.object({}).strict(),
    outputSchema: sessionStateSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (_request, extra) => formatToolResult(await client.getState(extra.signal)));

  return server;
}

export async function runControlMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const socketPath = requireEnvironment(env, CAME_CONTROL_SOCKET_ENV);
  const sessionId = requireEnvironment(env, CAME_SESSION_ID_ENV);
  const authToken = requireEnvironment(env, CAME_CONTROL_TOKEN_ENV);
  const client = new ControlPlaneClient({ socketPath, sessionId, authToken });
  const server = createControlMcpServer(client);
  await server.connect(new StdioServerTransport(input, output));
}

function formatToolResult(result: object): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ControlMcpConfigurationError(`Missing required environment variable ${name}`);
  }
  return value;
}

export class ControlMcpConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlMcpConfigurationError";
  }
}
