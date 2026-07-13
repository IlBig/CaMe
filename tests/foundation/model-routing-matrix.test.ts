import { describe, expect, it } from "vitest";

import { PHASE_ROUTING_MATRIX } from "../../src/index.js";

describe("phase routing matrix", () => {
  it("defines exactly one profile for each planned phase", () => {
    expect(PHASE_ROUTING_MATRIX.map(({ phase }) => phase)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(PHASE_ROUTING_MATRIX.map(({ phase }) => phase)).size).toBe(PHASE_ROUTING_MATRIX.length);
  });

  it("preserves the requested model and effort assignments", () => {
    expect(PHASE_ROUTING_MATRIX.map(({ model, effort }) => [model, effort])).toEqual([
      ["gpt-5.6-sol", "medium"],
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-sol", "xhigh"],
      ["gpt-5.6-sol", "max"],
      ["gpt-5.6-sol", "max"],
      ["gpt-5.6-terra", "high"],
      ["gpt-5.6-terra", "high"],
      ["gpt-5.6-sol", "max"],
    ]);
  });

  it("contains non-empty component names and reasons", () => {
    for (const profile of PHASE_ROUTING_MATRIX) {
      expect(profile.component.trim()).not.toBe("");
      expect(profile.reason.trim()).not.toBe("");
    }
  });
});
