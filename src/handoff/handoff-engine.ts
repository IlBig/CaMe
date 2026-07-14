import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AppServerBridge } from "../app-server/app-server-bridge.js";
import {
  threadSettingsUpdatedNotificationSchema,
  turnLifecycleNotificationSchema,
  type JsonRpcNotification,
} from "../app-server/protocol.js";
import {
  sessionStateSchema,
  type ConfirmSwitchRequest,
  type ModelProfile,
  type SessionState,
  type SwitchRequest,
  type SwitchResult,
} from "../contracts.js";
import type {
  ControlPlaneHandler,
  ControlPlaneRequestContext,
} from "../control-plane/protocol.js";

export const MAX_HANDOFF_CHAIN_SWITCHES = 5;

type PendingSwitch = Readonly<{
  switchId: string;
  threadId: string;
  sourceTurnId: string;
  target: ModelProfile;
  reason: string;
  continuation: string;
}>;

export type HandoffEngineOptions = {
  sessionId: string;
  bridge: AppServerBridge;
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
  readonly #unsubscribeNotification: () => void;
  #state: SessionState;
  #pending: PendingSwitch | null = null;
  #expectedContinuationTurnId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #fatalError: Error | null = null;

  public constructor(options: HandoffEngineOptions) {
    z.uuid().parse(options.sessionId);
    this.#bridge = options.bridge;
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
      void this.#enqueue(() => this.#handleNotification(notification)).catch((error: unknown) => {
        this.#enterFailed(asError(error));
      });
    });
  }

  public switchModel(request: SwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult> {
    return this.#enqueue(() => this.#scheduleSwitch(request, context), false);
  }

  public confirmSwitch(_request: ConfirmSwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult> {
    return this.#enqueue(() => {
      context.signal.throwIfAborted();
      return {
        status: "rejected",
        code: "confirmation_not_pending",
        message: "No model switch is awaiting confirmation",
      };
    }, false);
  }

  public getState(context: ControlPlaneRequestContext): Promise<SessionState> {
    return this.#enqueue(() => {
      context.signal.throwIfAborted();
      return sessionStateSchema.parse(cloneState(this.#state));
    }, false);
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribeNotification();
  }

  async #scheduleSwitch(request: SwitchRequest, context: ControlPlaneRequestContext): Promise<SwitchResult> {
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
    if (this.#state.currentProfile?.model === target.model && this.#state.currentProfile.effort === target.effort) {
      return { status: "noop" };
    }
    if (this.#state.autonomousSwitches >= MAX_HANDOFF_CHAIN_SWITCHES) {
      return rejected("switch_limit_reached", "The autonomous handoff chain reached its limit");
    }

    const switchId = randomUUID();
    this.#pending = {
      switchId,
      threadId,
      sourceTurnId: turnId,
      target,
      reason: request.reason,
      continuation: request.continuation,
    };
    this.#state.chainId ??= randomUUID();
    this.#state.autonomousSwitches += 1;
    this.#state.routerState = "waiting_turn_completion";
    return { status: "scheduled", switchId };
  }

  async #handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (this.#fatalError !== null) {
      return;
    }
    switch (notification.method) {
      case "turn/started":
        this.#handleTurnStarted(turnLifecycleNotificationSchema.parse(notification.params));
        return;
      case "turn/completed":
        await this.#handleTurnCompleted(turnLifecycleNotificationSchema.parse(notification.params));
        return;
      case "thread/settings/updated":
        this.#handleSettingsUpdated(threadSettingsUpdatedNotificationSchema.parse(notification.params));
        return;
    }
  }

  #handleTurnStarted(params: z.infer<typeof turnLifecycleNotificationSchema>): void {
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
    if (!isExpectedContinuation && this.#state.activeTurnId === null) {
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

  #enqueue<T>(operation: () => T | Promise<T>, fatalOnError = true): Promise<T> {
    const execution = this.#queue.then(() => {
      this.#assertOpen();
      return operation();
    });
    this.#queue = execution.then(
      () => undefined,
      (error: unknown) => {
        if (fatalOnError) {
          this.#enterFailed(asError(error));
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

  #enterFailed(error: Error): void {
    if (this.#fatalError !== null || this.#closed) {
      return;
    }
    this.#fatalError = error;
    this.#state.routerState = "failed";
    this.#onFatalError(error);
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new HandoffEngineError(String(error));
}
