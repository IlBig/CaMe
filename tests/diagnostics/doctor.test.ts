import { describe, expect, it } from "vitest";

import {
  executeDiagnosticCommand,
  formatDiagnosticReport,
  resolveDiagnosticExecutable,
  runDiagnostics,
  type DiagnosticCommandResult,
  type DiagnosticsOptions,
} from "../../src/index.js";

const SUCCESS: DiagnosticCommandResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
};

function result(stdout: string): DiagnosticCommandResult {
  return { ...SUCCESS, stdout };
}

function createRunner(pluginInventory: unknown): NonNullable<DiagnosticsOptions["runCommand"]> {
  return async (_command, args) => {
    switch (args.join(" ")) {
      case "--version":
        return result("codex-cli 0.144.3\n");
      case "--help":
        return result("--remote <ADDR>\n--remote-auth-token-env <ENV_VAR>\n");
      case "app-server --help":
        return result("--stdio\n");
      case "plugin --help":
        return result("Commands:\n  marketplace\n  add\n");
      case "plugin list --available --json":
        return result(JSON.stringify(pluginInventory));
      default:
        throw new Error(`Unexpected diagnostic command: ${args.join(" ")}`);
    }
  };
}

describe("CaMe diagnostics", () => {
  it("reports a ready installation when every required capability is present", async () => {
    const report = await runDiagnostics({
      nodeVersion: "24.12.0",
      platform: "darwin",
      env: { PATH: "/diagnostic/bin" },
      runCommand: createRunner({
        installed: [{ name: "came", installed: true, enabled: true }],
        available: [],
      }),
      resolveExecutable: async () => "/diagnostic/bin/came-mcp",
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toHaveLength(8);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(formatDiagnosticReport(report)).toContain("CaMe doctor: 0 failure(s), 0 warning(s)");
  });

  it("keeps preinstallation diagnostics ready while providing plugin remediation", async () => {
    const report = await runDiagnostics({
      nodeVersion: "24.0.0",
      platform: "linux",
      runCommand: createRunner({
        installed: [],
        available: [{ name: "came" }],
      }),
      resolveExecutable: async () => "/usr/local/bin/came-mcp",
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toContainEqual({
      id: "came.plugin",
      status: "warn",
      message: "CaMe Codex plugin is available but not installed",
      remediation: "Run `codex plugin add came@came-local`.",
    });
  });

  it("fails unsupported environments and missing executables without silent fallback", async () => {
    const commandFailure: DiagnosticCommandResult = {
      exitCode: null,
      stdout: "",
      stderr: "sensitive configuration detail",
      errorCode: "ENOENT",
    };
    const report = await runDiagnostics({
      nodeVersion: "23.9.0",
      platform: "win32",
      runCommand: async () => commandFailure,
      resolveExecutable: async () => null,
    });

    expect(report.ready).toBe(false);
    expect(report.checks.filter((check) => check.status === "fail")).toHaveLength(8);
    expect(JSON.stringify(report)).not.toContain(commandFailure.stderr);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "came.mcp_path",
      status: "fail",
    }));
  });

  it("rejects incomplete Codex capabilities and malformed plugin inventory", async () => {
    const runner: NonNullable<DiagnosticsOptions["runCommand"]> = async (_command, args) => {
      if (args.join(" ") === "--help") {
        return result("--remote <ADDR>\n");
      }
      if (args.join(" ") === "plugin list --available --json") {
        return result("{");
      }
      return createRunner({ installed: [], available: [] })("codex", args, process.env);
    };
    const report = await runDiagnostics({
      nodeVersion: "24.invalid",
      platform: "darwin",
      runCommand: runner,
      resolveExecutable: async () => "/bin/came-mcp",
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "node.version", status: "fail" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "codex.remote_tui", status: "fail" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "came.plugin", status: "fail" }));
  });

  it("rejects a plugin inventory object without the required arrays", async () => {
    const report = await runDiagnostics({
      nodeVersion: "24.0.0",
      platform: "darwin",
      runCommand: createRunner({}),
      resolveExecutable: async () => "/bin/came-mcp",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "came.plugin",
      status: "fail",
      message: "Codex plugin inventory does not contain the required arrays",
    }));
  });

  it("executes and resolves a real absolute executable without a shell", async () => {
    await expect(resolveDiagnosticExecutable(process.execPath, process.env)).resolves.toBe(process.execPath);
    const command = await executeDiagnosticCommand(process.execPath, ["--version"], process.env);

    expect(command.exitCode).toBe(0);
    expect(command.stdout).toMatch(/^v\d+\./u);
  });
});
