import { z } from "zod";

export const MAX_REASON_LENGTH = 2_000;
export const MAX_CONTINUATION_LENGTH = 32_000;

export const routerStateSchema = z.enum([
  "idle",
  "applying_settings",
  "awaiting_confirmation",
  "waiting_turn_completion",
  "starting_continuation",
  "failed",
]);

export type RouterState = z.infer<typeof routerStateSchema>;

export const modelProfileSchema = z.object({
  model: z.string().trim().min(1),
  effort: z.string().trim().min(1),
}).strict();

export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const switchRequestSchema = z.object({
  model: z.string().trim().min(1),
  effort: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
  continuation: z.string().trim().min(1).max(MAX_CONTINUATION_LENGTH),
}).strict();

export type SwitchRequest = z.infer<typeof switchRequestSchema>;

export const switchResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("scheduled"),
    switchId: z.uuid(),
  }).strict(),
  z.object({
    status: z.literal("confirmation_required"),
    requestId: z.uuid(),
  }).strict(),
  z.object({
    status: z.literal("noop"),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
  }).strict(),
]);

export type SwitchResult = z.infer<typeof switchResultSchema>;

export const confirmSwitchRequestSchema = z.object({
  requestId: z.uuid(),
}).strict();

export type ConfirmSwitchRequest = z.infer<typeof confirmSwitchRequestSchema>;

export const sessionStateSchema = z.object({
  sessionId: z.uuid(),
  activeThreadId: z.string().trim().min(1).nullable(),
  activeTurnId: z.string().trim().min(1).nullable(),
  currentProfile: modelProfileSchema.nullable(),
  chainId: z.uuid().nullable(),
  autonomousSwitches: z.number().int().min(0).max(5),
  routerState: routerStateSchema,
}).strict().superRefine((state, context) => {
  if (state.activeTurnId !== null && state.activeThreadId === null) {
    context.addIssue({
      code: "custom",
      path: ["activeTurnId"],
      message: "An active turn requires an active thread",
    });
  }
});

export type SessionState = z.infer<typeof sessionStateSchema>;
