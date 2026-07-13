import { randomUUID } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_CONTINUATION_LENGTH,
  MAX_REASON_LENGTH,
  confirmSwitchRequestSchema,
  modelProfileSchema,
  routerStateSchema,
  sessionStateSchema,
  switchRequestSchema,
  switchResultSchema,
  type ModelProfile,
  type RouterState,
} from "../../src/index.js";

describe("foundation contracts", () => {
  it("normalizes a valid model profile", () => {
    expect(modelProfileSchema.parse({ model: " gpt-5.6-sol ", effort: " high " })).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  it("rejects empty and unknown model profile fields", () => {
    expect(modelProfileSchema.safeParse({ model: " ", effort: "high" }).success).toBe(false);
    expect(modelProfileSchema.safeParse({ model: "gpt-5.6-sol", effort: "high", extra: true }).success).toBe(false);
  });

  it("accepts switch request boundaries", () => {
    const request = {
      model: "gpt-5.6-sol",
      effort: "medium",
      reason: "r".repeat(MAX_REASON_LENGTH),
      continuation: "c".repeat(MAX_CONTINUATION_LENGTH),
    };

    expect(switchRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects invalid switch requests", () => {
    const baseRequest = {
      model: "gpt-5.6-sol",
      effort: "medium",
      reason: "phase transition",
      continuation: "continue the implementation",
    };

    expect(switchRequestSchema.safeParse({ ...baseRequest, reason: "" }).success).toBe(false);
    expect(switchRequestSchema.safeParse({ ...baseRequest, reason: "r".repeat(MAX_REASON_LENGTH + 1) }).success).toBe(false);
    expect(switchRequestSchema.safeParse({ ...baseRequest, continuation: "c".repeat(MAX_CONTINUATION_LENGTH + 1) }).success).toBe(false);
    expect(switchRequestSchema.safeParse({ ...baseRequest, unexpected: true }).success).toBe(false);
  });

  it("validates every switch result variant", () => {
    expect(switchResultSchema.parse({ status: "scheduled", switchId: randomUUID() }).status).toBe("scheduled");
    expect(switchResultSchema.parse({ status: "confirmation_required", requestId: randomUUID() }).status).toBe("confirmation_required");
    expect(switchResultSchema.parse({ status: "noop" }).status).toBe("noop");
    expect(switchResultSchema.parse({ status: "rejected", code: "invalid_model", message: "Unavailable model" }).status).toBe("rejected");
  });

  it("rejects malformed identifiers", () => {
    expect(confirmSwitchRequestSchema.safeParse({ requestId: "not-a-uuid" }).success).toBe(false);
    expect(switchResultSchema.safeParse({ status: "scheduled", switchId: "not-a-uuid" }).success).toBe(false);
    expect(switchResultSchema.safeParse({ status: "confirmation_required", requestId: "not-a-uuid" }).success).toBe(false);
    expect(switchResultSchema.safeParse({ status: "noop", switchId: randomUUID() }).success).toBe(false);
    expect(switchResultSchema.safeParse({ status: "rejected", code: "", message: "Unavailable model" }).success).toBe(false);
  });

  it("enforces session state bounds and thread-turn consistency", () => {
    const validState = {
      sessionId: randomUUID(),
      activeThreadId: "thread-1",
      activeTurnId: "turn-1",
      currentProfile: { model: "gpt-5.6-sol", effort: "medium" },
      chainId: randomUUID(),
      autonomousSwitches: 5,
      routerState: "idle",
    };

    expect(sessionStateSchema.parse(validState)).toEqual(validState);
    expect(sessionStateSchema.safeParse({ ...validState, autonomousSwitches: 6 }).success).toBe(false);
    expect(sessionStateSchema.safeParse({ ...validState, autonomousSwitches: -1 }).success).toBe(false);
    expect(sessionStateSchema.safeParse({ ...validState, autonomousSwitches: 1.5 }).success).toBe(false);
    expect(sessionStateSchema.safeParse({ ...validState, activeThreadId: null }).success).toBe(false);
    expect(sessionStateSchema.safeParse({ ...validState, unexpected: true }).success).toBe(false);
  });

  it("keeps router states and inferred profiles exact", () => {
    expect(routerStateSchema.safeParse("unknown").success).toBe(false);
    expectTypeOf<RouterState>().toEqualTypeOf<
      | "idle"
      | "applying_settings"
      | "awaiting_confirmation"
      | "waiting_turn_completion"
      | "starting_continuation"
      | "failed"
    >();
    expectTypeOf<ModelProfile>().toEqualTypeOf<{ model: string; effort: string }>();
  });
});
