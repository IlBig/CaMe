import { describe, expect, it } from "vitest";

import {
  AppServerProtocolError,
  parseJsonRpcMessage,
  threadSettingsUpdatedNotificationSchema,
  threadSettingsUpdateParamsSchema,
  turnLifecycleNotificationSchema,
  turnStartParamsSchema,
} from "../../src/index.js";

describe("App Server protocol", () => {
  it("parses every JSON-RPC message category", () => {
    expect(parseJsonRpcMessage({ id: 1, method: "model/list", params: {} })).toMatchObject({ id: 1, method: "model/list" });
    expect(parseJsonRpcMessage({ method: "turn/completed", params: {} })).toMatchObject({ method: "turn/completed" });
    expect(parseJsonRpcMessage({ id: "a", result: {} })).toMatchObject({ id: "a", result: {} });
    expect(parseJsonRpcMessage({ id: "b", error: { code: -1, message: "failed" } })).toMatchObject({ id: "b" });
  });

  it("rejects conflicting and unsafe message identifiers", () => {
    expect(() => parseJsonRpcMessage({ id: 1, method: "model/list", result: {} })).toThrow(AppServerProtocolError);
    expect(() => parseJsonRpcMessage({ id: 1, result: {}, error: { code: -1, message: "failed" } })).toThrow(AppServerProtocolError);
    expect(() => parseJsonRpcMessage({ id: Number.MAX_SAFE_INTEGER + 1, result: {} })).toThrow(AppServerProtocolError);
  });

  it("validates the supported settings and turn subsets", () => {
    expect(threadSettingsUpdateParamsSchema.parse({ threadId: "thread-1", model: "model-a", effort: "high" })).toEqual({
      threadId: "thread-1",
      model: "model-a",
      effort: "high",
    });
    expect(turnStartParamsSchema.parse({
      threadId: "thread-1",
      input: [{ type: "text", text: "continue" }],
      model: "model-a",
      effort: "high",
    })).toMatchObject({ threadId: "thread-1" });
  });

  it("rejects unsupported fields in outbound subsets", () => {
    expect(threadSettingsUpdateParamsSchema.safeParse({ threadId: "thread-1", cwd: "/tmp" }).success).toBe(false);
    expect(turnStartParamsSchema.safeParse({ threadId: "thread-1", input: [], cwd: "/tmp" }).success).toBe(false);
  });

  it("validates the lifecycle notification subsets", () => {
    expect(threadSettingsUpdatedNotificationSchema.parse({
      threadId: "thread-1",
      threadSettings: { model: "model-a", effort: "high", cwd: "/tmp" },
    })).toMatchObject({ threadId: "thread-1", threadSettings: { model: "model-a", effort: "high" } });
    expect(turnLifecycleNotificationSchema.parse({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    })).toMatchObject({ threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    expect(turnLifecycleNotificationSchema.safeParse({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "unknown", items: [] },
    }).success).toBe(false);
  });
});
