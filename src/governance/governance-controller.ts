import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { z } from "zod";

import type {
  ModelProfile,
  SessionState,
  SwitchRequest,
  SwitchResult,
} from "../contracts.js";
import type { ControlPlaneRequestContext } from "../control-plane/protocol.js";
import type { AuditSink } from "./audit-log.js";

export const MAX_AUTONOMOUS_SWITCHES = 5;
export const DEFAULT_CONFIRMATION_TTL_MS = 2 * 60_000;

type PendingConfirmation = Readonly<{
  requestId: string;
  request: SwitchRequest;
  target: ModelProfile;
  threadId: string;
  turnId: string;
  expiresAt: number;
}>;

export type GovernanceAuthorization =
  | Readonly<{ status: "authorized" }>
  | Readonly<{ status: "result"; result: SwitchResult }>;

export type GovernanceConfirmation =
  | Readonly<{ status: "confirmed"; request: SwitchRequest; target: ModelProfile }>
  | Readonly<{ status: "result"; result: SwitchResult }>;

export type GovernanceControllerOptions = {
  sessionId: string;
  auditSink: AuditSink;
  confirmationTtlMs?: number;
  now?: () => number;
  fingerprintKey?: Buffer;
};

export class GovernanceController {
  readonly #sessionId: string;
  readonly #auditSink: AuditSink;
  readonly #confirmationTtlMs: number;
  readonly #now: () => number;
  readonly #fingerprintKey: Buffer;
  #pendingConfirmation: PendingConfirmation | null = null;

  public constructor(options: GovernanceControllerOptions) {
    z.uuid().parse(options.sessionId);
    if (options.confirmationTtlMs !== undefined && (!Number.isSafeInteger(options.confirmationTtlMs) || options.confirmationTtlMs <= 0)) {
      throw new RangeError("Confirmation TTL must be a positive safe integer");
    }
    if (options.fingerprintKey !== undefined && options.fingerprintKey.length < 32) {
      throw new RangeError("Audit fingerprint key must contain at least 32 bytes");
    }
    this.#sessionId = options.sessionId;
    this.#auditSink = options.auditSink;
    this.#confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#now = options.now ?? performance.now.bind(performance);
    this.#fingerprintKey = options.fingerprintKey === undefined
      ? randomBytes(32)
      : Buffer.from(options.fingerprintKey);
  }

  public async authorize(
    request: SwitchRequest,
    target: ModelProfile,
    state: SessionState,
    context: ControlPlaneRequestContext,
  ): Promise<GovernanceAuthorization> {
    this.#assertState(state);
    context.signal.throwIfAborted();
    await this.#auditSink.record({
      event: "switch_requested",
      requestId: context.requestId,
      chainId: state.chainId,
      threadId: state.activeThreadId ?? undefined,
      turnId: state.activeTurnId ?? undefined,
      sourceProfile: state.currentProfile,
      targetProfile: target,
      reasonFingerprint: this.#fingerprint(request.reason),
      reasonLength: request.reason.length,
      continuationLength: request.continuation.length,
    });
    context.signal.throwIfAborted();
    await this.#expireConfirmation(state);

    if (state.autonomousSwitches < MAX_AUTONOMOUS_SWITCHES) {
      return { status: "authorized" };
    }

    const pending = this.#pendingConfirmation;
    if (pending !== null) {
      const sameRequest = pending.threadId === state.activeThreadId
        && pending.turnId === state.activeTurnId
        && pending.target.model === target.model
        && pending.target.effort === target.effort
        && pending.request.reason === request.reason
        && pending.request.continuation === request.continuation;
      if (sameRequest) {
        return {
          status: "result",
          result: { status: "confirmation_required", requestId: pending.requestId },
        };
      }
      return {
        status: "result",
        result: rejected("confirmation_pending", "Another model switch is awaiting confirmation"),
      };
    }

    const threadId = state.activeThreadId;
    const turnId = state.activeTurnId;
    if (threadId === null || turnId === null) {
      return {
        status: "result",
        result: rejected("no_active_turn", "A model switch confirmation requires an active turn"),
      };
    }
    const requestId = randomUUID();
    this.#pendingConfirmation = {
      requestId,
      request: { ...request },
      target: { ...target },
      threadId,
      turnId,
      expiresAt: this.#now() + this.#confirmationTtlMs,
    };
    try {
      await this.#auditSink.record({
        event: "confirmation_required",
        requestId,
        chainId: state.chainId,
        threadId,
        turnId,
        targetProfile: target,
        decision: "required",
      });
    } catch (error) {
      this.#pendingConfirmation = null;
      throw error;
    }
    return {
      status: "result",
      result: { status: "confirmation_required", requestId },
    };
  }

  public async confirm(
    requestId: string,
    state: SessionState,
    context: ControlPlaneRequestContext,
  ): Promise<GovernanceConfirmation> {
    this.#assertState(state);
    context.signal.throwIfAborted();
    await this.#expireConfirmation(state);
    const pending = this.#pendingConfirmation;
    if (pending === null || pending.requestId !== requestId) {
      await this.#auditSink.record({
        event: "confirmation_rejected",
        requestId,
        chainId: state.chainId,
        decision: "unknown_or_consumed",
      });
      return {
        status: "result",
        result: rejected("invalid_confirmation", "Confirmation is unknown, expired, or already consumed"),
      };
    }
    if (state.activeThreadId !== pending.threadId || state.activeTurnId !== pending.turnId || state.routerState !== "idle") {
      this.#pendingConfirmation = null;
      await this.#auditSink.record({
        event: "confirmation_rejected",
        requestId,
        chainId: state.chainId,
        threadId: pending.threadId,
        turnId: pending.turnId,
        decision: "stale_context",
      });
      return {
        status: "result",
        result: rejected("stale_confirmation", "The confirmed turn is no longer active"),
      };
    }

    this.#pendingConfirmation = null;
    await this.#auditSink.record({
      event: "confirmation_consumed",
      requestId,
      chainId: state.chainId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      targetProfile: pending.target,
      decision: "confirmed",
    });
    context.signal.throwIfAborted();
    return {
      status: "confirmed",
      request: { ...pending.request },
      target: { ...pending.target },
    };
  }

  public async recordScheduled(
    switchId: string,
    target: ModelProfile,
    state: SessionState,
    confirmed: boolean,
  ): Promise<void> {
    this.#assertState(state);
    await this.#auditSink.record({
      event: "switch_scheduled",
      switchId,
      chainId: state.chainId,
      threadId: state.activeThreadId ?? undefined,
      turnId: state.activeTurnId ?? undefined,
      sourceProfile: state.currentProfile,
      targetProfile: target,
      decision: confirmed ? "confirmed" : "autonomous",
    });
  }

  public recordSettingsApplied(switchId: string, target: ModelProfile, state: SessionState): Promise<void> {
    this.#assertState(state);
    return this.#auditSink.record({
      event: "settings_applied",
      switchId,
      chainId: state.chainId,
      threadId: state.activeThreadId ?? undefined,
      targetProfile: target,
    });
  }

  public recordContinuationStarted(switchId: string, target: ModelProfile, state: SessionState): Promise<void> {
    this.#assertState(state);
    return this.#auditSink.record({
      event: "continuation_started",
      switchId,
      chainId: state.chainId,
      threadId: state.activeThreadId ?? undefined,
      turnId: state.activeTurnId ?? undefined,
      targetProfile: target,
    });
  }

  public async resetChain(state: SessionState): Promise<void> {
    this.#assertState(state);
    const pending = this.#pendingConfirmation;
    if (state.chainId === null && state.autonomousSwitches === 0 && pending === null) {
      return;
    }
    this.#pendingConfirmation = null;
    await this.#auditSink.record({
      event: "chain_reset",
      chainId: state.chainId,
      threadId: state.activeThreadId ?? undefined,
      turnId: state.activeTurnId ?? undefined,
      decision: pending === null ? "new_turn" : "new_turn_confirmation_invalidated",
    });
  }

  public recordFailure(error: Error, state: SessionState): Promise<void> {
    this.#assertState(state);
    return this.#auditSink.record({
      event: "handoff_failed",
      chainId: state.chainId,
      threadId: state.activeThreadId ?? undefined,
      turnId: state.activeTurnId ?? undefined,
      errorName: error.name,
    });
  }

  async #expireConfirmation(state: SessionState): Promise<void> {
    const pending = this.#pendingConfirmation;
    if (pending === null || this.#now() < pending.expiresAt) {
      return;
    }
    this.#pendingConfirmation = null;
    await this.#auditSink.record({
      event: "confirmation_expired",
      requestId: pending.requestId,
      chainId: state.chainId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      targetProfile: pending.target,
      decision: "expired",
    });
  }

  #fingerprint(reason: string): string {
    return createHmac("sha256", this.#fingerprintKey).update(reason, "utf8").digest("hex");
  }

  #assertState(state: SessionState): void {
    if (state.sessionId !== this.#sessionId) {
      throw new GovernanceError("Governance state belongs to another session");
    }
  }
}

export class GovernanceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

function rejected(code: string, message: string): SwitchResult {
  return { status: "rejected", code, message };
}
