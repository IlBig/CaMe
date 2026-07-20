import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

const CAME_PLUGIN_ID = "came@came-local";

export const MINIMUM_NODE_MAJOR = 24;
export const DIAGNOSTIC_COMMAND_TIMEOUT_MS = 5_000;
export const DIAGNOSTIC_COMMAND_MAX_BUFFER = 1024 * 1024;

export type DiagnosticStatus = "pass" | "warn" | "fail";

export type DiagnosticCheck = Readonly<{
  id: string;
  status: DiagnosticStatus;
  message: string;
  remediation?: string;
}>;

export type DiagnosticReport = Readonly<{
  ready: boolean;
  checks: readonly DiagnosticCheck[];
}>;

export type DiagnosticCommandResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}>;

export type DiagnosticsOptions = Readonly<{
  codexCommand?: string;
  mcpCommand?: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<DiagnosticCommandResult>;
  resolveExecutable?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
}>;

export async function runDiagnostics(options: DiagnosticsOptions = {}): Promise<DiagnosticReport> {
  const env = options.env ?? process.env;
  const codexCommand = options.codexCommand ?? "codex";
  const mcpCommand = options.mcpCommand ?? "came-mcp";
  const runCommand = options.runCommand ?? executeDiagnosticCommand;
  const resolveCommand = options.resolveExecutable ?? resolveDiagnosticExecutable;
  const checks: DiagnosticCheck[] = [];

  checks.push(checkNodeVersion(options.nodeVersion ?? process.versions.node));
  checks.push(checkPlatform(options.platform ?? process.platform));

  const version = await runCommand(codexCommand, ["--version"], env);
  checks.push(checkCommandResult(
    "codex.version",
    version,
    [/^codex-cli\s+\S+/mu],
    version.stdout.trim(),
    "Install Codex CLI and ensure `codex` is available on PATH.",
  ));

  const tuiHelp = await runCommand(codexCommand, ["--help"], env);
  checks.push(checkCommandResult(
    "codex.remote_tui",
    tuiHelp,
    [/--remote\b/mu, /--remote-auth-token-env\b/mu],
    "Codex TUI supports authenticated remote App Server connections",
    "Install a Codex CLI release that supports `--remote` and `--remote-auth-token-env`.",
  ));

  const appServerHelp = await runCommand(codexCommand, ["app-server", "--help"], env);
  checks.push(checkCommandResult(
    "codex.app_server",
    appServerHelp,
    [/--stdio\b/mu],
    "Codex App Server supports stdio transport",
    "Install a Codex CLI release whose App Server supports `--stdio`.",
  ));

  const pluginHelp = await runCommand(codexCommand, ["plugin", "--help"], env);
  checks.push(checkCommandResult(
    "codex.plugins",
    pluginHelp,
    [/\badd\b/mu, /\bmarketplace\b/mu],
    "Codex CLI supports plugin installation and marketplaces",
    "Install a Codex CLI release with `codex plugin add` and marketplace support.",
  ));

  const mcpPath = await resolveCommand(mcpCommand, env);
  checks.push(mcpPath === null
    ? fail(
        "came.mcp_path",
        `Executable '${mcpCommand}' is not available on PATH`,
        "Install or link the CaMe package so both `came` and `came-mcp` resolve on PATH.",
      )
    : pass("came.mcp_path", `CaMe MCP executable resolves to ${mcpPath}`));

  const pluginList = await runCommand(codexCommand, ["plugin", "list", "--available", "--json"], env);
  checks.push(checkPluginInstallation(pluginList));

  return {
    ready: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines = report.checks.map((check) => {
    const remediation = check.remediation === undefined ? "" : `\n  Remediation: ${check.remediation}`;
    return `${check.status.toUpperCase()} ${check.id}: ${check.message}${remediation}`;
  });
  const failures = report.checks.filter((check) => check.status === "fail").length;
  const warnings = report.checks.filter((check) => check.status === "warn").length;
  lines.push(`CaMe doctor: ${failures} failure(s), ${warnings} warning(s)`);
  return `${lines.join("\n")}\n`;
}

export function executeDiagnosticCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticCommandResult> {
  return new Promise((complete) => {
    execFile(command, [...args], {
      encoding: "utf8",
      env,
      maxBuffer: DIAGNOSTIC_COMMAND_MAX_BUFFER,
      timeout: DIAGNOSTIC_COMMAND_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      const errorCode = error?.killed === true
        ? "TIMEOUT"
        : error !== null && typeof error.code === "string" ? error.code : undefined;
      const result: DiagnosticCommandResult = {
        exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null,
        stdout,
        stderr,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
      complete(result);
    });
  });
}

export async function resolveDiagnosticExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [resolve(command)]
    : (env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "").map((entry) => resolve(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function checkNodeVersion(version: string): DiagnosticCheck {
  const majorText = /^(?<major>0|[1-9]\d*)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version)?.groups?.["major"];
  const major = majorText === undefined ? Number.NaN : Number.parseInt(majorText, 10);
  if (!Number.isSafeInteger(major) || major < MINIMUM_NODE_MAJOR) {
    return fail(
      "node.version",
      `Node.js ${version} does not satisfy the required major version >= ${MINIMUM_NODE_MAJOR}`,
      `Install Node.js ${MINIMUM_NODE_MAJOR} or newer.`,
    );
  }
  return pass("node.version", `Node.js ${version} satisfies the runtime requirement`);
}

function checkPlatform(platform: NodeJS.Platform): DiagnosticCheck {
  if (platform !== "darwin" && platform !== "linux") {
    return fail(
      "platform.ipc",
      `Platform '${platform}' is not supported by the Unix-socket control plane`,
      "Run CaMe on macOS or Linux.",
    );
  }
  return pass("platform.ipc", `Platform '${platform}' supports the Unix-socket control plane`);
}

function checkCommandResult(
  id: string,
  result: DiagnosticCommandResult,
  expected: readonly RegExp[],
  successMessage: string,
  remediation: string,
): DiagnosticCheck {
  if (result.exitCode !== 0) {
    return fail(id, commandFailureMessage(result), remediation);
  }
  if (!expected.every((pattern) => pattern.test(result.stdout))) {
    return fail(id, "Command output does not expose the required capability", remediation);
  }
  return pass(id, successMessage);
}

function checkPluginInstallation(result: DiagnosticCommandResult): DiagnosticCheck {
  if (result.exitCode !== 0) {
    return fail(
      "came.plugin",
      commandFailureMessage(result),
      `Repair Codex plugin configuration, then install \`${CAME_PLUGIN_ID}\`.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return fail(
      "came.plugin",
      "Codex returned invalid JSON for the plugin inventory",
      "Repair or update Codex CLI, then rerun `came doctor`.",
    );
  }
  if (!isRecord(payload)) {
    return fail("came.plugin", "Codex plugin inventory is not an object", "Update Codex CLI and rerun `came doctor`.");
  }
  if (!Array.isArray(payload["installed"]) || !Array.isArray(payload["available"])) {
    return fail(
      "came.plugin",
      "Codex plugin inventory does not contain the required arrays",
      "Update Codex CLI and rerun `came doctor`.",
    );
  }
  const installed = findPlugin(payload["installed"]);
  if (installed !== null) {
    if (installed["installed"] === true && installed["enabled"] === true) {
      return pass("came.plugin", "CaMe Codex plugin is installed and enabled");
    }
    return fail(
      "came.plugin",
      "CaMe Codex plugin is installed but disabled",
      "Enable CaMe in Codex plugin settings.",
    );
  }
  if (findPlugin(payload["available"]) !== null) {
    return warn(
      "came.plugin",
      "CaMe Codex plugin is available but not installed",
      `Run \`codex plugin add ${CAME_PLUGIN_ID}\`.`,
    );
  }
  return warn(
    "came.plugin",
    "CaMe Codex plugin is not present in configured marketplaces",
    "Rerun the CaMe installer.",
  );
}

function findPlugin(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const target = value.find((item) => isRecord(item) && item["pluginId"] === CAME_PLUGIN_ID);
  if (isRecord(target)) {
    return target;
  }
  for (const item of value) {
    if (isRecord(item) && item["name"] === "came") {
      return item;
    }
  }
  return null;
}

function commandFailureMessage(result: DiagnosticCommandResult): string {
  const detail = result.errorCode ?? `exit code ${String(result.exitCode)}`;
  return `Command failed: ${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pass(id: string, message: string): DiagnosticCheck {
  return { id, status: "pass", message };
}

function warn(id: string, message: string, remediation: string): DiagnosticCheck {
  return { id, status: "warn", message, remediation };
}

function fail(id: string, message: string, remediation: string): DiagnosticCheck {
  return { id, status: "fail", message, remediation };
}
