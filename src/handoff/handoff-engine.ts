import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AppServerBridge } from "../app-server/app-server-bridge.js";
import {
  threadSettingsUpdatedNotificationSchema,
  turnLifecycleNotificationSchema,
  type CodexModel,
  type JsonRpcNotification,
} from "../app-server/protocol.js";
import {
  explicitProfileRequestSchema,
  sessionStateSchema,
  type ConfirmSwitchRequest,
  type ExplicitProfileRequest,
  type ExplicitProfileResult,
  type ModelProfile,
  type SessionState,
  type SwitchRequest,
  type SwitchResult,
} from "../contracts.js";
import type {
  ControlPlaneHandler,
  ControlPlaneRequestContext,
} from "../control-plane/protocol.js";
import {
  MAX_AUTONOMOUS_SWITCHES,
  type GovernanceController,
  type HandoffFailureContext,
} from "../governance/governance-controller.js";

export const MAX_HANDOFF_CHAIN_SWITCHES = MAX_AUTONOMOUS_SWITCHES;

type PendingSwitch = Readonly<{
  switchId: string;
  threadId: string;
  sourceTurnId: string;
  target: ModelProfile;
  continuation: string;
}>;

export type HandoffEngineOptions = {
  sessionId: string;
  bridge: AppServerBridge;
  governance: GovernanceController;
  onFatalError: (error: Error) => void;
};

export class HandoffEngineError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HandoffEngineError";
  }
}

export class HandoffEngine implements ControlPlaneHandler {
  readonly #bridge: AppServerBridge;
  readonly #onFatalError: (error: Error) => void;
  readonly #governance: GovernanceController;
  readonly #unsubscribeNotification: () => void;
  #state: SessionState;
  #pending: PendingSwitch | null = null;
  #confirmationSourceTurnId: string | null = null;
  #expectedContinuationTurnId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #fatalError: Error | null = null;
  #explicitModelCatalog: readonly CodexModel[] | null = null;
  #failureContext: HandoffFailureContext | null = null;

  public constructor(options: HandoffEngineOptions) {
    z.uuid().parse(options.sessionId);
    this.#bridge = options.bridge;
    this.#governance = options.governance;
    this.#onFatalError = options.onFatalError;
    this.#state = {
      sessionId: options.sessionId,
      activeThreadId: null,
      activeTurnId: null,
      currentProfile: null,
      chainId: null,
      autonomousSwitches: 0,
      routerState: "idle",
    };
    this.#unsubscribeNotification = this.#bridge.onNotification((notification) => {
      void this.#enqueue(() => this.#handleNotification(notification)).catch(async (error: unknown) => {
        await this.#enterFailed(asError(error));
      });
    });
  }

  public switchModel(request: SwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult> {
    return this.#enqueue(() => this.#scheduleSwitch(request, context, null), context.signal);
  }

  public confirmSwitch(request: ConfirmSwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult> {
    return this.#enqueue(async () => {
      context.signal.throwIfAborted();
      const confirmation = await this.#governance.confirm(request.requestId, this.#state, context);
      if (confirmation.status === "result") {
        if (this.#state.routerState === "awaiting_confirmation" && !this.#governance.hasPendingConfirmation) {
          await this.#clearAwaitingConfirmation();
        }
        return confirmation.result;
      }
      if (this.#state.routerState !== "awaiting_confirmation" || this.#confirmationSourceTurnId === null) {
        throw new HandoffEngineError("Governance confirmed a switch without a pending handoff confirmation");
      }
      this.#confirmationSourceTurnId = null;
      this.#state.routerState = "idle";
      return this.#scheduleSwitch(confirmation.request, context, confirmation.target);
    }, context.signal);
  }

  public getState(context: ControlPlaneRequestContext): Promise<SessionState> {
    return this.#enqueue(() => {
      context.signal.throwIfAborted();
      return sessionStateSchema.parse(cloneState(this.#state));
    }, context.signal);
  }

  public applyExplicitProfile(request: ExplicitProfileRequest): Promise<ExplicitProfileResult> {
    return this.#enqueue(() => {
      const parsed = explicitProfileRequestSchema.safeParse(request);
      return parsed.success
        ? this.#applyExplicitProfile(parsed.data)
        : explicitRejected("invalid_explicit_command", "The explicit profile command is invalid");
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribeNotification();
  }

  async #applyExplicitProfile(request: ExplicitProfileRequest): Promise<ExplicitProfileResult> {
    if (this.#fatalError !== null || this.#state.routerState === "failed") {
      return explicitRejected("router_failed", "The profile router is in a failed state");
    }
    if (!this.#bridge.isInitialized) {
      return explicitRejected("app_server_not_initialized", "Codex App Server is not initialized");
    }
    if (this.#pending !== null || this.#state.routerState !== "idle") {
      return explicitRejected("handoff_in_progress", "Another profile handoff is already in progress");
    }
    if (this.#state.activeTurnId !== null) {
      return explicitRejected("turn_in_progress", "An explicit profile command requires an idle thread");
    }
    if (this.#state.activeThreadId !== null && this.#state.activeThreadId !== request.threadId) {
      return explicitRejected("thread_mismatch", "The explicit profile command targets a different thread");
    }

    const models = this.#explicitModelCatalog ?? await this.#loadExplicitModelCatalog();
    const matches = resolveExplicitModels(models, request.modelQuery);
    if (matches.length === 0) {
      return explicitRejected("unsupported_model", "The requested model is not available");
    }
    if (matches.length !== 1) {
      return explicitRejected("ambiguous_model", "The requested model is ambiguous");
    }
    const model = matches[0];
    if (model === undefined) {
      throw new HandoffEngineError("Explicit model catalog match disappeared");
    }
    const effort = request.effort.toLowerCase();
    if (!model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) {
      return explicitRejected("unsupported_effort", "The requested effort is not supported by the selected model");
    }
    if (!isSafeProfileToken(model.model) || !isSafeProfileToken(effort)) {
      return explicitRejected("invalid_catalog_profile", "The selected catalog profile is not safe to apply");
    }

    const target = { model: model.model, effort };
    this.#state.activeThreadId ??= request.threadId;
    await this.#governance.resetChain(this.#state);
    this.#state.chainId = null;
    this.#state.autonomousSwitches = 0;
    if (this.#state.currentProfile?.model === target.model && this.#state.currentProfile.effort === target.effort) {
      return { status: "noop", profile: target };
    }

    const switchId = randomUUID();
    this.#failureContext = { switchId, targetProfile: { ...target } };
    this.#state.routerState = "applying_settings";
    await this.#governance.recordExplicitSwitch(switchId, target, this.#state);
    await this.#bridge.updateThreadSettings({
      threadId: request.threadId,
      model: target.model,
      effort: target.effort,
    });
    this.#assertOpen();
    this.#state.currentProfile = { ...target };
    await this.#governance.recordSettingsApplied(switchId, target, this.#state);
    this.#state.routerState = "idle";
    this.#failureContext = null;
    return { status: "applied", profile: target };
  }

  async #loadExplicitModelCatalog(): Promise<readonly CodexModel[]> {
    const models = await this.#bridge.listModels();
    this.#assertOpen();
    this.#explicitModelCatalog = models.map((model) => ({
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => ({ ...option })),
    }));
    return this.#explicitModelCatalog;
  }

  async #scheduleSwitch(
    request: SwitchRequest,
    context: ControlPlaneRequestContext,
    confirmedTarget: ModelProfile | null,
  ): Promise<SwitchResult> {
    context.signal.throwIfAborted();
    if (this.#fatalError !== null || this.#state.routerState === "failed") {
      return rejected("router_failed", "The handoff engine is in a failed state");
    }
    if (!this.#bridge.isInitialized) {
      return rejected("app_server_not_initialized", "Codex App Server is not initialized");
    }
    if (this.#pending !== null || this.#state.routerState !== "idle") {
      return rejected("handoff_in_progress", "Another model handoff is already in progress");
    }
    const threadId = this.#state.activeThreadId;
    const turnId = this.#state.activeTurnId;
    if (threadId === null || turnId === null) {
      return rejected("no_active_turn", "A model handoff requires an active Codex turn");
    }
    const models = await this.#bridge.listModels();
    context.signal.throwIfAborted();
    const matches = models.filter((model) => !model.hidden && (model.id === request.model || model.model === request.model));
    if (matches.length === 0) {
      return rejected("unsupported_model", `Model '${request.model}' is not available`);
    }
    if (matches.length !== 1) {
      return rejected("ambiguous_model", `Model '${request.model}' matches multiple model identifiers`);
    }
    const model = matches[0];
    if (model === undefined) {
      throw new HandoffEngineError("Model catalog match disappeared");
    }
    const effortSupported = model.supportedReasoningEfforts.some((option) => option.reasoningEffort === request.effort);
    if (!effortSupported) {
      return rejected("unsupported_effort", `Effort '${request.effort}' is not supported by model '${model.model}'`);
    }
    const target = { model: model.model, effort: request.effort };
    if (confirmedTarget !== null
      && (confirmedTarget.model !== target.model || confirmedTarget.effort !== target.effort)) {
      return rejected("confirmation_target_changed", "The confirmed model profile is no longer canonical");
    }
    if (this.#state.currentProfile?.model === target.model && this.#state.currentProfile.effort === target.effort) {
      return { status: "noop" };
    }
    const confirmed = confirmedTarget !== null;
    if (!confirmed) {
      const authorization = await this.#governance.authorize(request, target, this.#state, context);
      if (authorization.status === "result") {
        if (authorization.result.status === "confirmation_required") {
          this.#confirmationSourceTurnId = turnId;
          this.#state.routerState = "awaiting_confirmation";
        }
        return authorization.result;
      }
    }

    const switchId = randomUUID();
    const previousChainId = this.#state.chainId;
    const previousAutonomousSwitches = this.#state.autonomousSwitches;
    this.#failureContext = { switchId, targetProfile: { ...target } };
    this.#pending = {
      switchId,
      threadId,
      sourceTurnId: turnId,
      target,
      continuation: request.continuation,
    };
    this.#state.chainId ??= randomUUID();
    if (!confirmed) {
      this.#state.autonomousSwitches += 1;
    }
    this.#state.routerState = "waiting_turn_completion";
    try {
      await this.#governance.recordScheduled(switchId, target, this.#state, confirmed);
    } catch (error) {
      this.#pending = null;
      this.#state.chainId = previousChainId;
      this.#state.autonomousSwitches = previousAutonomousSwitches;
      this.#state.routerState = "idle";
      throw error;
    }
    return { status: "scheduled", switchId };
  }

  async #handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (this.#fatalError !== null) {
      return;
    }
    switch (notification.method) {
      case "turn/started":
        await this.#handleTurnStarted(turnLifecycleNotificationSchema.parse(notification.params));
        return;
      case "turn/completed":
        await this.#handleTurnCompleted(turnLifecycleNotificationSchema.parse(notification.params));
        return;
      case "thread/settings/updated":
        this.#handleSettingsUpdated(threadSettingsUpdatedNotificationSchema.parse(notification.params));
        return;
    }
  }

  async #handleTurnStarted(params: z.infer<typeof turnLifecycleNotificationSchema>): Promise<void> {
    if (params.turn.status !== "inProgress") {
      throw new HandoffEngineError("turn/started did not contain an in-progress turn");
    }
    if (this.#state.activeTurnId !== null && this.#state.activeTurnId !== params.turn.id) {
      if (this.#state.activeThreadId !== params.threadId) {
        return;
      }
      throw new HandoffEngineError("A second turn started while the tracked turn was active");
    }

    const isExpectedContinuation = this.#expectedContinuationTurnId === params.turn.id;
    const isConfirmationResponse = this.#state.routerState === "awaiting_confirmation"
      && this.#confirmationSourceTurnId !== null
      && this.#state.activeThreadId === params.threadId
      && this.#state.activeTurnId === null;
    if (!isExpectedContinuation && !isConfirmationResponse && this.#state.activeTurnId === null) {
      await this.#governance.resetChain(this.#state);
      if (this.#state.activeThreadId !== params.threadId) {
        this.#state.currentProfile = null;
      }
      this.#state.chainId = null;
      this.#state.autonomousSwitches = 0;
    }
    if (isExpectedContinuation && this.#state.activeThreadId !== params.threadId) {
      throw new HandoffEngineError("Continuation started on a different thread");
    }

    this.#state.activeThreadId = params.threadId;
    this.#state.activeTurnId = params.turn.id;
    if (isExpectedContinuation) {
      this.#expectedContinuationTurnId = null;
    }
  }

  async #handleTurnCompleted(params: z.infer<typeof turnLifecycleNotificationSchema>): Promise<void> {
    if (params.turn.status === "inProgress") {
      throw new HandoffEngineError("turn/completed contained an in-progress turn");
    }
    if (this.#state.activeThreadId !== params.threadId || this.#state.activeTurnId !== params.turn.id) {
      return;
    }
    this.#state.activeTurnId = null;

    const pending = this.#pending;
    if (pending === null) {
      if (this.#state.routerState === "awaiting_confirmation") {
        if (this.#confirmationSourceTurnId === params.turn.id && params.turn.status === "completed") {
          return;
        }
        await this.#clearAwaitingConfirmation();
        return;
      }
      this.#state.routerState = "idle";
      return;
    }
    if (pending.threadId !== params.threadId || pending.sourceTurnId !== params.turn.id) {
      throw new HandoffEngineError("Pending switch does not match the completed source turn");
    }
    if (params.turn.status !== "completed") {
      throw new HandoffEngineError(`Source turn ended with status '${params.turn.status}'`);
    }

    this.#state.routerState = "applying_settings";
    await this.#bridge.updateThreadSettings({
      threadId: pending.threadId,
      model: pending.target.model,
      effort: pending.target.effort,
    });
    this.#assertOpen();
    this.#state.currentProfile = { ...pending.target };
    await this.#governance.recordSettingsApplied(pending.switchId, pending.target, this.#state);
    this.#state.routerState = "starting_continuation";
    const turn = await this.#bridge.startTurn({
      threadId: pending.threadId,
      input: [{ type: "text", text: pending.continuation }],
      model: pending.target.model,
      effort: pending.target.effort,
    });
    this.#assertOpen();
    if (turn.status !== "inProgress") {
      throw new HandoffEngineError("Continuation did not start in progress");
    }
    this.#expectedContinuationTurnId = turn.id;
    this.#state.activeThreadId = pending.threadId;
    this.#state.activeTurnId = turn.id;
    this.#state.routerState = "idle";
    this.#pending = null;
    await this.#governance.recordContinuationStarted(pending.switchId, pending.target, this.#state);
    this.#failureContext = null;
  }

  #handleSettingsUpdated(params: z.infer<typeof threadSettingsUpdatedNotificationSchema>): void {
    if (this.#state.activeThreadId !== null && this.#state.activeThreadId !== params.threadId) {
      return;
    }
    this.#state.activeThreadId = params.threadId;
    this.#state.currentProfile = params.threadSettings.effort === null || params.threadSettings.effort === undefined
      ? null
      : {
          model: params.threadSettings.model,
          effort: params.threadSettings.effort,
        };
  }

  async #clearAwaitingConfirmation(): Promise<void> {
    await this.#governance.resetChain(this.#state);
    this.#confirmationSourceTurnId = null;
    this.#state.chainId = null;
    this.#state.autonomousSwitches = 0;
    this.#state.routerState = "idle";
  }

  #enqueue<T>(operation: () => T | Promise<T>, nonFatalSignal?: AbortSignal): Promise<T> {
    const execution = this.#queue.then(() => {
      this.#assertOpen();
      return operation();
    });
    this.#queue = execution.then(
      () => undefined,
      async (error: unknown) => {
        if (!isSignalAbort(error, nonFatalSignal)) {
          await this.#enterFailed(asError(error));
        }
      },
    );
    return execution;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new HandoffEngineError("Handoff engine is closed");
    }
  }

  async #enterFailed(error: Error): Promise<void> {
    if (this.#fatalError !== null || this.#closed) {
      return;
    }
    this.#fatalError = error;
    this.#state.routerState = "failed";
    let fatalError = error;
    try {
      await this.#governance.recordFailure(error, this.#state, this.#failureContext ?? undefined);
    } catch (auditError) {
      fatalError = new AggregateError([error, auditError], "Handoff and audit failed");
    }
    this.#onFatalError(fatalError);
  }
}

function cloneState(state: SessionState): SessionState {
  return {
    ...state,
    currentProfile: state.currentProfile === null ? null : { ...state.currentProfile },
  };
}

function rejected(code: string, message: string): SwitchResult {
  return { status: "rejected", code, message };
}

function explicitRejected(code: string, message: string): ExplicitProfileResult {
  return { status: "rejected", code, message };
}

function resolveExplicitModels(models: readonly CodexModel[], query: string): CodexModel[] {
  const normalizedQuery = normalizeModelName(query);
  if (normalizedQuery === "") {
    return [];
  }
  return models.filter((model) => {
    if (model.hidden) {
      return false;
    }
    const aliases = [model.id, model.model, model.displayName].flatMap((value) => {
      const normalized = normalizeModelName(value);
      return normalized.startsWith("gpt ") ? [normalized, normalized.slice(4)] : [normalized];
    });
    return aliases.includes(normalizedQuery);
  });
}

function normalizeModelName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isSafeProfileToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new HandoffEngineError(String(error));
}

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
}
