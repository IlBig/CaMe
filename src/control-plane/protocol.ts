import { z } from "zod";

import {
  confirmSwitchRequestSchema,
  sessionStateSchema,
  switchRequestSchema,
  switchResultSchema,
  type ConfirmSwitchRequest,
  type SessionState,
  type SwitchRequest,
  type SwitchResult,
} from "../contracts.js";

export const CONTROL_PROTOCOL_VERSION = 1;
export const CAME_CONTROL_SOCKET_ENV = "CAME_CONTROL_SOCKET";
export const CAME_CONTROL_TOKEN_ENV = "CAME_CONTROL_TOKEN";
export const DEFAULT_CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTROL_REPLAY_TTL_MS = 5 * 60_000;
export const DEFAULT_CONTROL_MAX_REPLAY_ENTRIES = 4_096;
export const DEFAULT_CONTROL_MAX_CONNECTIONS = 32;

export const controlAuthTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const controlErrorCodeSchema = z.enum([
  "authentication_failed",
  "session_mismatch",
  "replay_detected",
  "invalid_request",
  "capacity_exceeded",
  "request_timeout",
  "internal_error",
]);

export type ControlErrorCode = z.infer<typeof controlErrorCodeSchema>;

export const controlEnvelopeSchema = z.object({
  version: z.literal(CONTROL_PROTOCOL_VERSION),
  requestId: z.uuid(),
  sessionId: z.uuid(),
  token: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
}).strict();

const switchControlRequestSchema = controlEnvelopeSchema.extend({
  method: z.literal("switch"),
  params: switchRequestSchema,
}).strict();

const confirmControlRequestSchema = controlEnvelopeSchema.extend({
  method: z.literal("confirm"),
  params: confirmSwitchRequestSchema,
}).strict();

const stateControlRequestSchema = controlEnvelopeSchema.extend({
  method: z.literal("state"),
  params: z.object({}).strict(),
}).strict();

export const controlRequestSchema = z.discriminatedUnion("method", [
  switchControlRequestSchema,
  confirmControlRequestSchema,
  stateControlRequestSchema,
]);

export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlMethod = ControlRequest["method"];

export const controlSuccessResponseSchema = z.object({
  requestId: z.uuid(),
  ok: z.literal(true),
  result: z.unknown(),
}).strict();

export const controlErrorResponseSchema = z.object({
  requestId: z.uuid().nullable(),
  ok: z.literal(false),
  error: z.object({
    code: controlErrorCodeSchema,
    message: z.string().min(1),
  }).strict(),
}).strict();

export const controlResponseSchema = z.discriminatedUnion("ok", [
  controlSuccessResponseSchema,
  controlErrorResponseSchema,
]);

export type ControlResponse = z.infer<typeof controlResponseSchema>;

export const controlResultSchemas = {
  switch: switchResultSchema,
  confirm: switchResultSchema,
  state: sessionStateSchema,
} as const;

export type ControlPlaneRequestContext = Readonly<{
  requestId: string;
  signal: AbortSignal;
}>;

export interface ControlPlaneHandler {
  switchModel(request: SwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult>;
  confirmSwitch(request: ConfirmSwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult>;
  getState(context: ControlPlaneRequestContext): Promise<SessionState>;
}
