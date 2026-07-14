import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AppServerBridge,
  GovernanceController,
  HandoffEngine,
  HandoffEngineError,
  type AuditEventInput,
  type AuditSink,
  type CodexModel,
  type ControlPlaneRequestContext,
  type SessionState,
  type SwitchRequest,
} from "../../src/index.js";
import { JsonLinePeer } from "../app-server/test-peer.js";

const INITIALIZE_RESULT = {
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex-test",
};

const MODEL_A: CodexModel = {
  id: "model-a",
  model: "model-a",
  displayName: "Model A",
  description: "Baseline model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deep" },
  ],
};

const MODEL_B: CodexModel = {
  id: "model-b-id",
  model: "model-b",
  displayName: "Model B",
  description: "Deep model",
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "Deep" },
    { reasoningEffort: "xhigh", description: "Deeper" },
  ],
};

const SWITCH_REQUEST: SwitchRequest = {
  model: MODEL_B.id,
  effort: "xhigh",
  reason: "The remaining task requires deeper reasoning",
  continuation: "Continue the implementation from the current state",
};

type Harness = {
  bridge: AppServerBridge;
  engine: HandoffEngine;
  fatalErrors: Error[];
  fromServer: PassThrough;
  peer: JsonLinePeer;
  sessionId: string;
  auditEvents: AuditEventInput[];
};

class MemoryAuditSink implements AuditSink {
  public readonly events: AuditEventInput[] = [];

  public async record(event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

function createHarness(auditSink: AuditSink = new MemoryAuditSink()): Harness {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const bridge = new AppServerBridge(fromServer, toServer);
  const fatalErrors: Error[] = [];
  const sessionId = randomUUID();
  return {
    bridge,
    engine: new HandoffEngine({
      bridge,
      sessionId,
      governance: new GovernanceController({ sessionId, auditSink }),
      onFatalError: (error) => fatalErrors.push(error),
    }),
    auditEvents: auditSink instanceof MemoryAuditSink ? auditSink.events : [],
    fatalErrors,
    fromServer,
    peer: new JsonLinePeer(toServer),
    sessionId,
  };
}

function context(signal = new AbortController().signal): ControlPlaneRequestContext {
  return { requestId: randomUUID(), signal };
}

async function initialize(harness: Harness): Promise<void> {
  const initializing = harness.bridge.initialize("0.1.0");
  const request = await harness.peer.next();
  JsonLinePeer.write(harness.fromServer, { id: request["id"], result: INITIALIZE_RESULT });
  await expect(harness.peer.next()).resolves.toMatchObject({ method: "initialized" });
  await initializing;
}

async function activateTurn(
  harness: Harness,
  threadId = "thread-1",
  turnId = "turn-1",
  profile = { model: MODEL_A.model, effort: "medium" },
): Promise<SessionState> {
  JsonLinePeer.write(harness.fromServer, {
    method: "thread/settings/updated",
    params: { threadId, threadSettings: profile },
  });
  JsonLinePeer.write(harness.fromServer, {
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } },
  });
  return harness.engine.getState(context());
}

async function respondWithModels(harness: Harness, models: CodexModel[]): Promise<void> {
  const request = await harness.peer.next();
  expect(request).toMatchObject({ method: "model/list", params: {} });
  JsonLinePeer.write(harness.fromServer, { id: request["id"], result: { data: models, nextCursor: null } });
}

async function closeHarness(harness: Harness): Promise<void> {
  harness.engine.close();
  harness.bridge.close();
}

async function completeHandoff(
  harness: Harness,
  sourceTurnId: string,
  nextTurnId: string,
  model: CodexModel,
  effort: string,
): Promise<void> {
  const switching = harness.engine.switchModel({
    ...SWITCH_REQUEST,
    model: model.model,
    effort,
  }, context());
  await respondWithModels(harness, [model]);
  await expect(switching).resolves.toMatchObject({ status: "scheduled" });
  JsonLinePeer.write(harness.fromServer, {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: sourceTurnId, status: "completed", items: [] } },
  });
  const updateRequest = await harness.peer.next();
  JsonLinePeer.write(harness.fromServer, { id: updateRequest["id"], result: {} });
  const startRequest = await harness.peer.next();
  JsonLinePeer.write(harness.fromServer, {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: nextTurnId, status: "inProgress", items: [] } },
  });
  JsonLinePeer.write(harness.fromServer, {
    id: startRequest["id"],
    result: { turn: { id: nextTurnId, status: "inProgress", items: [] } },
  });
  await expect(harness.engine.getState(context())).resolves.toMatchObject({ activeTurnId: nextTurnId });
}

describe("HandoffEngine", () => {
  it("updates settings and starts the continuation on the same thread", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await expect(activateTurn(harness)).resolves.toMatchObject({
        activeThreadId: "thread-1",
        activeTurnId: "turn-1",
        currentProfile: { model: "model-a", effort: "medium" },
      });

      const switching = harness.engine.switchModel(SWITCH_REQUEST, context());
      await respondWithModels(harness, [MODEL_A, MODEL_B]);
      await expect(switching).resolves.toMatchObject({ status: "scheduled" });

      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });
      const updateRequest = await harness.peer.next();
      expect(updateRequest).toMatchObject({
        method: "thread/settings/update",
        params: { threadId: "thread-1", model: "model-b", effort: "xhigh" },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "thread/settings/updated",
        params: { threadId: "thread-1", threadSettings: { model: "model-b", effort: "xhigh" } },
      });
      JsonLinePeer.write(harness.fromServer, { id: updateRequest["id"], result: {} });

      const startRequest = await harness.peer.next();
      expect(startRequest).toMatchObject({
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: SWITCH_REQUEST.continuation }],
          model: "model-b",
          effort: "xhigh",
        },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        id: startRequest["id"],
        result: { turn: { id: "turn-2", status: "inProgress", items: [] } },
      });

      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        activeThreadId: "thread-1",
        activeTurnId: "turn-2",
        currentProfile: { model: "model-b", effort: "xhigh" },
        autonomousSwitches: 1,
        routerState: "idle",
      });
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("serializes a source completion that arrives during model lookup", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await activateTurn(harness);
      const switching = harness.engine.switchModel(SWITCH_REQUEST, context());
      const modelRequest = await harness.peer.next();
      expect(modelRequest).toMatchObject({ method: "model/list" });

      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        id: modelRequest["id"],
        result: { data: [MODEL_A, MODEL_B], nextCursor: null },
      });
      await expect(switching).resolves.toMatchObject({ status: "scheduled" });

      const updateRequest = await harness.peer.next();
      expect(updateRequest).toMatchObject({ method: "thread/settings/update", params: { threadId: "thread-1" } });
      JsonLinePeer.write(harness.fromServer, { id: updateRequest["id"], result: {} });
      const startRequest = await harness.peer.next();
      expect(startRequest).toMatchObject({ method: "turn/start", params: { threadId: "thread-1" } });
      JsonLinePeer.write(harness.fromServer, {
        id: startRequest["id"],
        result: { turn: { id: "turn-2", status: "inProgress", items: [] } },
      });

      await expect(harness.engine.getState(context())).resolves.toMatchObject({ activeTurnId: "turn-2" });
    } finally {
      await closeHarness(harness);
    }
  });

  it("rejects unavailable, ambiguous, unsupported, and unchanged profiles", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await activateTurn(harness);

      const unavailable = harness.engine.switchModel({ ...SWITCH_REQUEST, model: "missing" }, context());
      await respondWithModels(harness, [MODEL_A, MODEL_B]);
      await expect(unavailable).resolves.toMatchObject({ status: "rejected", code: "unsupported_model" });

      const ambiguous = harness.engine.switchModel({ ...SWITCH_REQUEST, model: MODEL_B.model }, context());
      await respondWithModels(harness, [MODEL_B, { ...MODEL_B, id: MODEL_B.model }]);
      await expect(ambiguous).resolves.toMatchObject({ status: "rejected", code: "ambiguous_model" });

      const unsupportedEffort = harness.engine.switchModel({ ...SWITCH_REQUEST, effort: "medium" }, context());
      await respondWithModels(harness, [MODEL_B]);
      await expect(unsupportedEffort).resolves.toMatchObject({ status: "rejected", code: "unsupported_effort" });

      const unchanged = harness.engine.switchModel({
        ...SWITCH_REQUEST,
        model: MODEL_A.model,
        effort: "medium",
      }, context());
      await respondWithModels(harness, [MODEL_A]);
      await expect(unchanged).resolves.toEqual({ status: "noop" });
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("requires initialization and an active turn", async () => {
    const harness = createHarness();
    try {
      await expect(harness.engine.switchModel(SWITCH_REQUEST, context())).resolves.toMatchObject({
        status: "rejected",
        code: "app_server_not_initialized",
      });
      await initialize(harness);
      await expect(harness.engine.switchModel(SWITCH_REQUEST, context())).resolves.toMatchObject({
        status: "rejected",
        code: "no_active_turn",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("bounds a handoff chain and resets it on a new user turn", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await activateTurn(harness);
      let sourceTurnId = "turn-1";
      for (let index = 1; index <= 5; index += 1) {
        const target = index % 2 === 1 ? MODEL_B : MODEL_A;
        const effort = target === MODEL_B ? "xhigh" : "medium";
        const nextTurnId = `turn-${index + 1}`;
        await completeHandoff(harness, sourceTurnId, nextTurnId, target, effort);
        sourceTurnId = nextTurnId;
      }

      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        autonomousSwitches: 5,
        currentProfile: { model: MODEL_B.model, effort: "xhigh" },
      });
      const noop = harness.engine.switchModel({ ...SWITCH_REQUEST, model: MODEL_B.model }, context());
      await respondWithModels(harness, [MODEL_B]);
      await expect(noop).resolves.toEqual({ status: "noop" });

      const governed = harness.engine.switchModel({
        ...SWITCH_REQUEST,
        model: MODEL_A.model,
        effort: "medium",
      }, context());
      await respondWithModels(harness, [MODEL_A]);
      const confirmation = await governed;
      expect(confirmation).toMatchObject({ status: "confirmation_required" });
      if (confirmation.status !== "confirmation_required") {
        throw new Error("Expected a governed confirmation request");
      }

      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        activeTurnId: sourceTurnId,
        autonomousSwitches: 5,
        routerState: "awaiting_confirmation",
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: sourceTurnId, status: "completed", items: [] } },
      });
      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        activeTurnId: null,
        autonomousSwitches: 5,
        routerState: "awaiting_confirmation",
      });
      sourceTurnId = "turn-approval";
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: sourceTurnId, status: "inProgress", items: [] } },
      });

      const confirming = harness.engine.confirmSwitch({ requestId: confirmation.requestId }, context());
      await respondWithModels(harness, [MODEL_A]);
      await expect(confirming).resolves.toMatchObject({ status: "scheduled" });
      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        autonomousSwitches: 5,
        routerState: "waiting_turn_completion",
      });
      await expect(harness.engine.confirmSwitch({ requestId: confirmation.requestId }, context())).resolves.toMatchObject({
        status: "rejected",
        code: "invalid_confirmation",
      });

      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: sourceTurnId, status: "completed", items: [] } },
      });
      const updateRequest = await harness.peer.next();
      expect(updateRequest).toMatchObject({ method: "thread/settings/update", params: { threadId: "thread-1" } });
      JsonLinePeer.write(harness.fromServer, { id: updateRequest["id"], result: {} });
      const startRequest = await harness.peer.next();
      expect(startRequest).toMatchObject({ method: "turn/start", params: { threadId: "thread-1" } });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-confirmed", status: "inProgress", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        id: startRequest["id"],
        result: { turn: { id: "turn-confirmed", status: "inProgress", items: [] } },
      });
      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        activeTurnId: "turn-confirmed",
        autonomousSwitches: 5,
      });
      sourceTurnId = "turn-confirmed";
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: sourceTurnId, status: "completed", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-user", status: "inProgress", items: [] } },
      });
      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        activeTurnId: "turn-user",
        chainId: null,
        autonomousSwitches: 0,
      });
      await expect(harness.engine.confirmSwitch({ requestId: confirmation.requestId }, context())).resolves.toMatchObject({
        status: "rejected",
        code: "invalid_confirmation",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("invalidates an unconfirmed switch after the immediate response turn", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await activateTurn(harness);
      let sourceTurnId = "turn-1";
      for (let index = 1; index <= 5; index += 1) {
        const target = index % 2 === 1 ? MODEL_B : MODEL_A;
        const effort = target === MODEL_B ? "xhigh" : "medium";
        const nextTurnId = `turn-${index + 1}`;
        await completeHandoff(harness, sourceTurnId, nextTurnId, target, effort);
        sourceTurnId = nextTurnId;
      }

      const governed = harness.engine.switchModel({
        ...SWITCH_REQUEST,
        model: MODEL_A.model,
        effort: "medium",
      }, context());
      await respondWithModels(harness, [MODEL_A]);
      const confirmation = await governed;
      if (confirmation.status !== "confirmation_required") {
        throw new Error("Expected a governed confirmation request");
      }
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: sourceTurnId, status: "completed", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-response", status: "inProgress", items: [] } },
      });
      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-response", status: "completed", items: [] } },
      });

      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        activeTurnId: null,
        chainId: null,
        autonomousSwitches: 0,
        routerState: "idle",
      });
      await expect(harness.engine.confirmSwitch({ requestId: confirmation.requestId }, context())).resolves.toMatchObject({
        status: "rejected",
        code: "invalid_confirmation",
      });
      expect(harness.auditEvents).toContainEqual(expect.objectContaining({
        event: "chain_reset",
        decision: "new_turn_confirmation_invalidated",
      }));
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("does not fail the engine when a control request is cancelled", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await activateTurn(harness);
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));

      await expect(harness.engine.switchModel(SWITCH_REQUEST, context(controller.signal))).rejects.toThrow("cancelled");
      await expect(harness.engine.getState(context())).resolves.toMatchObject({ routerState: "idle" });
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("enters a terminal failed state when the source turn does not complete", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await activateTurn(harness);
      const switching = harness.engine.switchModel(SWITCH_REQUEST, context());
      await respondWithModels(harness, [MODEL_B]);
      await expect(switching).resolves.toMatchObject({ status: "scheduled" });

      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", items: [] } },
      });

      await expect.poll(() => harness.fatalErrors.length).toBe(1);
      expect(harness.fatalErrors[0]).toBeInstanceOf(HandoffEngineError);
      await expect(harness.engine.getState(context())).resolves.toMatchObject({ routerState: "failed" });

      JsonLinePeer.write(harness.fromServer, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });
      await expect(harness.engine.getState(context())).resolves.toMatchObject({ routerState: "failed" });
      expect(harness.fatalErrors).toHaveLength(1);
    } finally {
      await closeHarness(harness);
    }
  });

  it("fails closed when a required audit record cannot be persisted", async () => {
    const auditSink: AuditSink = {
      record: async (event) => {
        if (event.event === "switch_scheduled") {
          throw new Error("audit unavailable");
        }
      },
    };
    const harness = createHarness(auditSink);
    try {
      await initialize(harness);
      await activateTurn(harness);
      const switching = harness.engine.switchModel(SWITCH_REQUEST, context());
      await respondWithModels(harness, [MODEL_B]);

      await expect(switching).rejects.toThrow("audit unavailable");
      await expect.poll(() => harness.fatalErrors.length).toBe(1);
      await expect(harness.engine.getState(context())).resolves.toMatchObject({
        routerState: "failed",
        autonomousSwitches: 0,
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("rejects an unknown or already-consumed confirmation", async () => {
    const harness = createHarness();
    try {
      await expect(harness.engine.confirmSwitch({ requestId: randomUUID() }, context())).resolves.toEqual({
        status: "rejected",
        code: "invalid_confirmation",
        message: "Confirmation is unknown, expired, or already consumed",
      });
    } finally {
      await closeHarness(harness);
    }
  });
});
