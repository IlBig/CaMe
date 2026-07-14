import { describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/came.js";
import type { DiagnosticReport } from "../../src/index.js";

const READY_REPORT: DiagnosticReport = {
  ready: true,
  checks: [{ id: "node.version", status: "pass", message: "ready" }],
};

describe("came CLI", () => {
  it("rejects unsupported arguments without starting a session", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expect(main(["--unknown"])).resolves.toBe(2);
      expect(stderr).toHaveBeenCalledWith("Usage: came [doctor [--json]]\n");
    } finally {
      stderr.mockRestore();
    }
  });

  it("prints a human-readable diagnostic report", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(main(["doctor"], { runDiagnostics: async () => READY_REPORT })).resolves.toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("PASS node.version: ready"));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("CaMe doctor: 0 failure(s), 0 warning(s)"));
    } finally {
      stdout.mockRestore();
    }
  });

  it("prints JSON and returns failure when diagnostics are not ready", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const report: DiagnosticReport = {
      ready: false,
      checks: [{ id: "came.mcp_path", status: "fail", message: "missing" }],
    };

    try {
      await expect(main(["doctor", "--json"], { runDiagnostics: async () => report })).resolves.toBe(1);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(report);
    } finally {
      stdout.mockRestore();
    }
  });

  it("rejects unsupported doctor arguments before running diagnostics", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runDiagnostics = vi.fn(async () => READY_REPORT);

    try {
      await expect(main(["doctor", "--unknown"], { runDiagnostics })).resolves.toBe(2);
      expect(runDiagnostics).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith("Usage: came [doctor [--json]]\n");
    } finally {
      stderr.mockRestore();
    }
  });
});
