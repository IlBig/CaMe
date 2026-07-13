import { z } from "zod";

export const requestIdSchema = z.union([z.string(), z.number().int().safe()]);

export type RequestId = z.infer<typeof requestIdSchema>;

const jsonRpcRequestSchema = z.object({
  id: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
}).passthrough();

const jsonRpcNotificationSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
}).passthrough();

const jsonRpcResponseSchema = z.object({
  id: requestIdSchema,
  result: z.unknown(),
}).passthrough();

const jsonRpcErrorSchema = z.object({
  id: requestIdSchema,
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcError;

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (typeof value !== "object" || value === null) {
    throw new AppServerProtocolError("JSON-RPC message must be an object");
  }

  const hasMethod = "method" in value;
  const hasId = "id" in value;
  const hasResult = "result" in value;
  const hasError = "error" in value;

  if ((hasMethod && (hasResult || hasError)) || (hasResult && hasError)) {
    throw new AppServerProtocolError("JSON-RPC message has conflicting discriminators");
  }

  try {
    if (hasMethod && hasId) {
      return jsonRpcRequestSchema.parse(value);
    }

    if (hasMethod) {
      return jsonRpcNotificationSchema.parse(value);
    }

    if (hasError) {
      return jsonRpcErrorSchema.parse(value);
    }

    if (hasResult) {
      return jsonRpcResponseSchema.parse(value);
    }
  } catch (error) {
    throw new AppServerProtocolError("Invalid JSON-RPC message fields", { cause: error });
  }

  throw new AppServerProtocolError("Unsupported JSON-RPC message shape");
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isJsonRpcError(message: JsonRpcMessage): message is JsonRpcError {
  return "error" in message && "id" in message;
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "result" in message && "id" in message;
}

export class AppServerProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerProtocolError";
  }
}

export class AppServerConnectionClosedError extends Error {
  public constructor(message = "Codex App Server connection closed", options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerConnectionClosedError";
  }
}

export class AppServerTimeoutError extends Error {
  public constructor(method: string, timeoutMs: number) {
    super(`Codex App Server request '${method}' timed out after ${timeoutMs} ms`);
    this.name = "AppServerTimeoutError";
  }
}

export class AppServerRequestError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(error: JsonRpcError["error"]) {
    super(error.message);
    this.name = "AppServerRequestError";
    this.code = error.code;
    this.data = error.data;
  }
}

export const initializeResponseSchema = z.object({
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
  userAgent: z.string(),
}).passthrough();

export const initializeParamsSchema = z.object({
  clientInfo: z.object({
    name: z.string(),
    version: z.string(),
    title: z.string().nullable().optional(),
  }).passthrough(),
  capabilities: z.object({
    experimentalApi: z.boolean().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const reasoningEffortOptionSchema = z.object({
  reasoningEffort: z.string().min(1),
  description: z.string(),
}).passthrough();

export const codexModelSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().min(1),
  supportedReasoningEfforts: z.array(reasoningEffortOptionSchema),
}).passthrough();

export type CodexModel = z.infer<typeof codexModelSchema>;

export const modelListResponseSchema = z.object({
  data: z.array(codexModelSchema),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

export const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  items: z.array(z.unknown()),
}).passthrough();

export type CodexTurn = z.infer<typeof turnSchema>;

export const turnStartResponseSchema = z.object({
  turn: turnSchema,
}).passthrough();

export const threadSettingsUpdatedNotificationSchema = z.object({
  threadId: z.string().min(1),
  threadSettings: z.object({
    model: z.string().min(1),
    effort: z.string().min(1).nullable().optional(),
  }).passthrough(),
}).passthrough();

export const turnLifecycleNotificationSchema = z.object({
  threadId: z.string().min(1),
  turn: turnSchema,
}).passthrough();

export const threadSettingsUpdateParamsSchema = z.object({
  threadId: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  effort: z.string().min(1).nullable().optional(),
}).strict();

export type ThreadSettingsUpdateParams = z.infer<typeof threadSettingsUpdateParamsSchema>;

export const turnStartParamsSchema = z.object({
  threadId: z.string().min(1),
  input: z.array(z.object({
    type: z.literal("text"),
    text: z.string(),
  }).strict()),
  model: z.string().min(1).nullable().optional(),
  effort: z.string().min(1).nullable().optional(),
}).strict();

export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type TextUserInput = TurnStartParams["input"][number];
