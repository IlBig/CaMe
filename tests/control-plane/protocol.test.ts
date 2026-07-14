import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONTROL_PROTOCOL_VERSION,
  controlRequestSchema,
  controlResponseSchema,
} from "../../src/index.js";

const TOKEN = "a".repeat(43);

describe("control plane protocol", () => {
  it("validates strict method-specific requests", () => {
    const envelope = {
      version: CONTROL_PROTOCOL_VERSION,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      token: TOKEN,
    };

    expect(controlRequestSchema.safeParse({
      ...envelope,
      method: "switch",
      params: {
        model: "gpt-test",
        effort: "high",
        reason: "The task needs deeper reasoning",
        continuation: "Continue the implementation",
      },
    }).success).toBe(true);
    expect(controlRequestSchema.safeParse({
      ...envelope,
      method: "confirm",
      params: { requestId: randomUUID() },
    }).success).toBe(true);
    expect(controlRequestSchema.safeParse({
      ...envelope,
      method: "state",
      params: {},
    }).success).toBe(true);
  });

  it("rejects unknown methods, extra fields, and mismatched parameters", () => {
    const envelope = {
      version: CONTROL_PROTOCOL_VERSION,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      token: TOKEN,
    };

    expect(controlRequestSchema.safeParse({ ...envelope, method: "unknown", params: {} }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...envelope, method: "state", params: { extra: true } }).success).toBe(false);
    expect(controlRequestSchema.safeParse({
      ...envelope,
      method: "confirm",
      params: { requestId: "not-a-uuid" },
    }).success).toBe(false);
  });

  it("requires response discriminators and bounded error codes", () => {
    const requestId = randomUUID();

    expect(controlResponseSchema.safeParse({ requestId, ok: true, result: { status: "noop" } }).success).toBe(true);
    expect(controlResponseSchema.safeParse({
      requestId,
      ok: false,
      error: { code: "replay_detected", message: "duplicate" },
    }).success).toBe(true);
    expect(controlResponseSchema.safeParse({
      requestId,
      ok: false,
      error: { code: "arbitrary", message: "invalid" },
    }).success).toBe(false);
  });
});
