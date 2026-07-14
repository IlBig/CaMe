import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GovernanceController,
  GovernanceError,
  type AuditEventInput,
  type AuditSink,
  type ControlPlaneRequestContext,
  type SessionState,
  type SwitchRequest,
} from "../../src/index.js";

const REQUEST: SwitchRequest = {
  model: "model-b",
  effort: "high",
  reason: "private reason",
  continuation: "private continuation",
};

class MemoryAuditSink implements AuditSink {
  public readonly events: AuditEventInput[] = [];

  public async record(event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

function createState(sessionId: string, autonomousSwitches: number): SessionState {
  return {
    sessionId,
    activeThreadId: "thread-1",
    activeTurnId: "turn-1",
    currentProfile: { model: "model-a", effort: "medium" },
    chainId: randomUUID(),
    autonomousSwitches,
    routerState: "idle",
  };
}

function context(): ControlPlaneRequestContext {
  return { requestId: randomUUID(), signal: new AbortController().signal };
}

describe("GovernanceController", () => {
  it("allows switches below the threshold and emits privacy-preserving audit metadata", async () => {
    const sessionId = randomUUID();
    const auditSink = new MemoryAuditSink();
    const governance = new GovernanceController({
      sessionId,
      auditSink,
      fingerprintKey: Buffer.alloc(32, 7),
    });

    await expect(governance.authorize(REQUEST, { model: "model-b", effort: "high" }, createState(sessionId, 4), context())).resolves.toEqual({
      status: "authorized",
    });

    expect(auditSink.events).toHaveLength(1);
    expect(auditSink.events[0]).toMatchObject({
      event: "switch_requested",
      reasonLength: REQUEST.reason.length,
      continuationLength: REQUEST.continuation.length,
    });
    expect(auditSink.events[0]?.reasonFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(auditSink.events)).not.toContain(REQUEST.reason);
    expect(JSON.stringify(auditSink.events)).not.toContain(REQUEST.continuation);
  });

  it("issues one-time confirmations at the threshold", async () => {
    const sessionId = randomUUID();
    const auditSink = new MemoryAuditSink();
    const governance = new GovernanceController({ sessionId, auditSink });
    const state = createState(sessionId, 5);

    const authorization = await governance.authorize(REQUEST, { model: "model-b", effort: "high" }, state, context());
    expect(authorization.status).toBe("result");
    if (authorization.status !== "result" || authorization.result.status !== "confirmation_required") {
      throw new Error("Expected confirmation request");
    }
    const confirmationId = authorization.result.requestId;
    const repeated = await governance.authorize(REQUEST, { model: "model-b", effort: "high" }, state, context());
    expect(repeated).toEqual({ status: "result", result: { status: "confirmation_required", requestId: confirmationId } });
    const conflicting = await governance.authorize(
      { ...REQUEST, reason: "different private reason" },
      { model: "model-b", effort: "high" },
      state,
      context(),
    );
    expect(conflicting).toMatchObject({
      status: "result",
      result: { status: "rejected", code: "confirmation_pending" },
    });

    await expect(governance.confirm(confirmationId, state, context())).resolves.toMatchObject({
      status: "confirmed",
      request: REQUEST,
      target: { model: "model-b", effort: "high" },
    });
    await expect(governance.confirm(confirmationId, state, context())).resolves.toMatchObject({
      status: "result",
      result: { status: "rejected", code: "invalid_confirmation" },
    });
    expect(auditSink.events.map((event) => event.event)).toEqual([
      "switch_requested",
      "confirmation_required",
      "switch_requested",
      "switch_requested",
      "confirmation_consumed",
      "confirmation_rejected",
    ]);
  });

  it("expires confirmations with a monotonic clock", async () => {
    const sessionId = randomUUID();
    const auditSink = new MemoryAuditSink();
    let now = 100;
    const governance = new GovernanceController({
      sessionId,
      auditSink,
      confirmationTtlMs: 20,
      now: () => now,
    });
    const state = createState(sessionId, 5);
    const authorization = await governance.authorize(REQUEST, { model: "model-b", effort: "high" }, state, context());
    if (authorization.status !== "result" || authorization.result.status !== "confirmation_required") {
      throw new Error("Expected confirmation request");
    }
    now = 121;

    await expect(governance.confirm(authorization.result.requestId, state, context())).resolves.toMatchObject({
      status: "result",
      result: { status: "rejected", code: "invalid_confirmation" },
    });
    expect(auditSink.events.map((event) => event.event)).toContain("confirmation_expired");
  });

  it("invalidates pending confirmation on stale context and chain reset", async () => {
    const sessionId = randomUUID();
    const auditSink = new MemoryAuditSink();
    const governance = new GovernanceController({ sessionId, auditSink });
    const state = createState(sessionId, 5);
    const first = await governance.authorize(REQUEST, { model: "model-b", effort: "high" }, state, context());
    if (first.status !== "result" || first.result.status !== "confirmation_required") {
      throw new Error("Expected confirmation request");
    }
    const staleState = { ...state, activeTurnId: "turn-2" };
    await expect(governance.confirm(first.result.requestId, staleState, context())).resolves.toMatchObject({
      status: "result",
      result: { status: "rejected", code: "stale_confirmation" },
    });

    const second = await governance.authorize(REQUEST, { model: "model-b", effort: "high" }, state, context());
    if (second.status !== "result" || second.result.status !== "confirmation_required") {
      throw new Error("Expected second confirmation request");
    }
    await governance.resetChain(state);
    await expect(governance.confirm(second.result.requestId, state, context())).resolves.toMatchObject({
      status: "result",
      result: { status: "rejected", code: "invalid_confirmation" },
    });
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event: "chain_reset",
      decision: "new_turn_confirmation_invalidated",
    }));
  });

  it("rejects foreign session state and invalid options", async () => {
    const sessionId = randomUUID();
    const governance = new GovernanceController({ sessionId, auditSink: new MemoryAuditSink() });

    await expect(governance.authorize(
      REQUEST,
      { model: "model-b", effort: "high" },
      createState(randomUUID(), 0),
      context(),
    )).rejects.toBeInstanceOf(GovernanceError);
    expect(() => new GovernanceController({ sessionId, auditSink: new MemoryAuditSink(), confirmationTtlMs: 0 })).toThrow(RangeError);
    expect(() => new GovernanceController({ sessionId, auditSink: new MemoryAuditSink(), fingerprintKey: Buffer.alloc(8) })).toThrow(RangeError);
  });
});
