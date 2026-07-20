import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CAME_MARKETPLACE_NAME = "came-local";
export const CAME_PLUGIN_ID = `came@${CAME_MARKETPLACE_NAME}`;
export const INSTALLER_MINIMUM_NODE_MAJOR = 24;
export const INSTALLER_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export type InstallerCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

export type InstallerCommandOptions = Readonly<{
  cwd?: string;
  env: NodeJS.ProcessEnv;
}>;

export type InstallerCommandRunner = (
  command: string,
  args: readonly string[],
  options: InstallerCommandOptions,
) => Promise<InstallerCommandResult>;

export type PackageManager = Readonly<{
  command: string;
  argsPrefix: readonly string[];
}>;

export type InstallCaMeOptions = Readonly<{
  sourceRoot: string;
  dataRoot?: string;
  binDir?: string;
  cachebuster?: string;
  env?: NodeJS.ProcessEnv;
  packageManager?: PackageManager;
  runCommand?: InstallerCommandRunner;
}>;

export type InstallCaMeResult = Readonly<{
  version: string;
  releasePath: string;
  binDir: string;
  marketplaceName: string;
  migratedPluginIds: readonly string[];
}>;

type JsonObject = Record<string, unknown>;

type PathSnapshot =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "file"; content: Buffer; mode: number }>
  | Readonly<{ kind: "symlink"; target: string }>;

type InstalledPlugin = Readonly<{
  pluginId: string;
  name: string;
  version?: string;
  installed: boolean;
  enabled: boolean;
  sourcePath?: string;
  marketplaceSource?: string;
}>;

export class CaMeInstallerError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaMeInstallerError";
  }
}

export class CaMeInstallerCommandError extends CaMeInstallerError {
  public readonly command: string;
  public readonly args: readonly string[];
  public readonly stdout: string;
  public readonly stderr: string;

  public constructor(
    command: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
    options?: ErrorOptions,
  ) {
    const detail = stderr.trim() || stdout.trim() || "no diagnostic output";
    super(`Command failed: ${command} ${args.join(" ")}\n${detail}`, options);
    this.name = "CaMeInstallerCommandError";
    this.command = command;
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function installCaMe(options: InstallCaMeOptions): Promise<InstallCaMeResult> {
  validateNodeVersion(process.versions.node);
  const sourceRoot = resolve(options.sourceRoot);
  const env = { ...process.env, ...options.env };
  const home = requireEnvironment(env, "HOME");
  const dataRoot = resolve(options.dataRoot ?? join(home, ".local/share/came"));
  const binDir = resolve(options.binDir ?? join(home, ".local/bin"));
  const cachebuster = options.cachebuster ?? createCachebuster(new Date());
  if (!/^\d{14}$/u.test(cachebuster)) {
    throw new CaMeInstallerError("Installer cachebuster must contain exactly 14 UTC timestamp digits");
  }
  const runCommand = options.runCommand ?? executeInstallerCommand;
  const packageManager = options.packageManager ?? packageManagerFromEnvironment(env);

  const packagePath = join(sourceRoot, "package.json");
  const lockfilePath = join(sourceRoot, "pnpm-lock.yaml");
  const pluginPath = join(sourceRoot, "plugins/came");
  const cameCliPath = join(sourceRoot, "dist/cli/came.js");
  const mcpCliPath = join(sourceRoot, "dist/cli/came-mcp.js");
  await Promise.all([
    requireReadableFile(packagePath),
    requireReadableFile(lockfilePath),
    requireReadableFile(join(pluginPath, ".codex-plugin/plugin.json")),
    requireReadableFile(join(pluginPath, ".mcp.json")),
    requireReadableFile(cameCliPath),
    requireReadableFile(mcpCliPath),
  ]);

  const packageJson = await readJsonObject(packagePath);
  const baseVersion = requireString(packageJson, "version", packagePath);
  const pluginVersion = `${baseVersion}+codex.${cachebuster}`;
  const commandOptions: InstallerCommandOptions = { env };
  const codexVersion = await runCommand("codex", ["--version"], commandOptions);
  if (!/^codex-cli\s+\S+/mu.test(codexVersion.stdout)) {
    throw new CaMeInstallerError("Codex CLI did not return a supported version response");
  }

  const marketplaceInventory = parseMarketplaceInventory(
    (await runCommand("codex", ["plugin", "marketplace", "list", "--json"], commandOptions)).stdout,
  );
  const configuredMarketplace = marketplaceInventory.find((marketplace) => marketplace.name === CAME_MARKETPLACE_NAME);
  if (configuredMarketplace !== undefined && resolve(configuredMarketplace.source) !== dataRoot) {
    throw new CaMeInstallerError(
      `Marketplace '${CAME_MARKETPLACE_NAME}' already points to ${configuredMarketplace.source}`,
    );
  }
  const marketplaceWasConfigured = configuredMarketplace !== undefined;

  const initialPlugins = parsePluginInventory(
    (await runCommand("codex", ["plugin", "list", "--available", "--json"], commandOptions)).stdout,
  );
  const targetWasInstalled = initialPlugins.some((plugin) => plugin.pluginId === CAME_PLUGIN_ID && plugin.installed);
  const legacyPlugins = initialPlugins.filter((plugin) =>
    plugin.pluginId !== CAME_PLUGIN_ID
      && plugin.name === "came"
      && plugin.installed
      && isManagedLegacyPlugin(plugin, sourceRoot));

  const releasesDir = join(dataRoot, "releases");
  const releaseId = `${baseVersion}-${cachebuster}-${randomUUID().slice(0, 8)}`;
  const stagingPath = join(dataRoot, `.staging-${releaseId}`);
  const releasePath = join(releasesDir, releaseId);
  const currentPath = join(dataRoot, "current");
  const marketplacePath = join(dataRoot, ".agents/plugins/marketplace.json");
  const cameBinPath = join(binDir, "came");
  const mcpBinPath = join(binDir, "came-mcp");
  const lockPath = join(dataRoot, ".install.lock");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const lockHandle = await acquireInstallLock(lockPath);

  let releaseCreated = false;
  let activationStarted = false;
  let marketplaceAdded = false;
  let targetInstallAttempted = false;
  const removedLegacyPlugins: InstalledPlugin[] = [];
  let currentSnapshot: PathSnapshot = { kind: "absent" };
  let marketplaceSnapshot: PathSnapshot = { kind: "absent" };
  let cameBinSnapshot: PathSnapshot = { kind: "absent" };
  let mcpBinSnapshot: PathSnapshot = { kind: "absent" };

  try {
    await mkdir(releasesDir, { recursive: true, mode: 0o700 });
    await mkdir(binDir, { recursive: true, mode: 0o755 });
    await rm(stagingPath, { recursive: true, force: true });
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await Promise.all([
      cp(join(sourceRoot, "dist"), join(stagingPath, "dist"), { recursive: true }),
      cp(pluginPath, join(stagingPath, "plugins/came"), { recursive: true }),
      cp(packagePath, join(stagingPath, "package.json")),
      cp(lockfilePath, join(stagingPath, "pnpm-lock.yaml")),
    ]);
    await configurePackagedPlugin(stagingPath, pluginVersion, mcpBinPath);
    await runCommand(packageManager.command, [
      ...packageManager.argsPrefix,
      "--dir",
      stagingPath,
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
    ], { env: { ...env, CI: "1" } });
    await Promise.all([
      requireReadableFile(join(stagingPath, "node_modules/@modelcontextprotocol/sdk/package.json")),
      requireReadableFile(join(stagingPath, "node_modules/ws/package.json")),
      requireReadableFile(join(stagingPath, "node_modules/zod/package.json")),
    ]);
    await rename(stagingPath, releasePath);
    releaseCreated = true;

    [currentSnapshot, marketplaceSnapshot, cameBinSnapshot, mcpBinSnapshot] = await Promise.all([
      snapshotPath(currentPath),
      snapshotPath(marketplacePath),
      snapshotPath(cameBinPath),
      snapshotPath(mcpBinPath),
    ]);
    if (currentSnapshot.kind === "file") {
      throw new CaMeInstallerError(`Refusing to replace non-symlink path ${currentPath}`);
    }
    if (currentSnapshot.kind === "symlink"
      && !isWithin(resolve(dirname(currentPath), currentSnapshot.target), releasesDir)) {
      throw new CaMeInstallerError(`Refusing to replace unmanaged symlink ${currentPath}`);
    }
    assertReplaceableLauncher(cameBinSnapshot, cameBinPath, "dist/cli/came.js");
    assertReplaceableLauncher(mcpBinSnapshot, mcpBinPath, "dist/cli/came-mcp.js");
    activationStarted = true;
    await replaceSymlink(currentPath, relative(dataRoot, releasePath));
    await writeLauncher(cameBinPath, join(releasePath, "dist/cli/came.js"));
    await writeLauncher(mcpBinPath, join(releasePath, "dist/cli/came-mcp.js"));
    await writeMarketplace(marketplacePath);

    if (!marketplaceWasConfigured) {
      await runCommand("codex", ["plugin", "marketplace", "add", dataRoot, "--json"], commandOptions);
      marketplaceAdded = true;
    }
    targetInstallAttempted = true;
    await runCommand("codex", ["plugin", "add", CAME_PLUGIN_ID, "--json"], commandOptions);
    await verifyTargetPlugin(runCommand, commandOptions, pluginVersion);

    const doctorEnvironment = {
      ...env,
      PATH: [binDir, env["PATH"] ?? ""].filter((entry) => entry !== "").join(delimiter),
    };
    const doctor = parseJsonObject((await runCommand(cameBinPath, ["doctor", "--json"], {
      env: doctorEnvironment,
    })).stdout, "CaMe doctor output");
    if (doctor["ready"] !== true) {
      throw new CaMeInstallerError("Installed CaMe runtime did not pass diagnostics");
    }

    for (const plugin of legacyPlugins) {
      await runCommand("codex", ["plugin", "remove", plugin.pluginId, "--json"], commandOptions);
      removedLegacyPlugins.push(plugin);
    }
    await verifyTargetPlugin(runCommand, commandOptions, pluginVersion);

    return {
      version: pluginVersion,
      releasePath,
      binDir,
      marketplaceName: CAME_MARKETPLACE_NAME,
      migratedPluginIds: removedLegacyPlugins.map((plugin) => plugin.pluginId),
    };
  } catch (error) {
    if (!activationStarted) {
      if (releaseCreated) {
        await rm(releasePath, { recursive: true, force: true });
      }
      throw error;
    }
    const rollbackErrors: Error[] = [];
    await attemptRollback(async () => restorePath(currentPath, currentSnapshot), rollbackErrors);
    await attemptRollback(async () => restorePath(marketplacePath, marketplaceSnapshot), rollbackErrors);
    await attemptRollback(async () => restorePath(cameBinPath, cameBinSnapshot), rollbackErrors);
    await attemptRollback(async () => restorePath(mcpBinPath, mcpBinSnapshot), rollbackErrors);

    if (targetInstallAttempted) {
      if (targetWasInstalled) {
        await attemptRollback(async () => {
          await runCommand("codex", ["plugin", "add", CAME_PLUGIN_ID, "--json"], commandOptions);
        }, rollbackErrors);
      } else {
        await attemptRollback(async () => {
          await runCommand("codex", ["plugin", "remove", CAME_PLUGIN_ID, "--json"], commandOptions);
        }, rollbackErrors);
      }
    }
    for (const plugin of removedLegacyPlugins) {
      await attemptRollback(async () => {
        await runCommand("codex", ["plugin", "add", plugin.pluginId, "--json"], commandOptions);
      }, rollbackErrors);
    }
    if (marketplaceAdded) {
      await attemptRollback(async () => {
        await runCommand("codex", ["plugin", "marketplace", "remove", CAME_MARKETPLACE_NAME, "--json"], commandOptions);
      }, rollbackErrors);
    }
    if (releaseCreated) {
      await attemptRollback(async () => rm(releasePath, { recursive: true, force: true }), rollbackErrors);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([toError(error), ...rollbackErrors], "CaMe installation failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
    await lockHandle.close();
    await rm(lockPath, { force: true });
  }
}

export function createCachebuster(date: Date): string {
  return date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
}

export function executeInstallerCommand(
  command: string,
  args: readonly string[],
  options: InstallerCommandOptions,
): Promise<InstallerCommandResult> {
  return new Promise((complete, reject) => {
    execFile(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      encoding: "utf8",
      maxBuffer: INSTALLER_COMMAND_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new CaMeInstallerCommandError(command, args, stdout, stderr, { cause: error }));
        return;
      }
      complete({ stdout, stderr });
    });
  });
}

function packageManagerFromEnvironment(env: NodeJS.ProcessEnv): PackageManager {
  if (env["CAME_PACKAGE_MANAGER"] === "corepack") {
    return { command: "corepack", argsPrefix: ["pnpm"] };
  }
  if (env["CAME_PACKAGE_MANAGER"] === undefined || env["CAME_PACKAGE_MANAGER"] === "pnpm") {
    return { command: "pnpm", argsPrefix: [] };
  }
  throw new CaMeInstallerError("CAME_PACKAGE_MANAGER must be either 'pnpm' or 'corepack'");
}

function validateNodeVersion(version: string): void {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < INSTALLER_MINIMUM_NODE_MAJOR) {
    throw new CaMeInstallerError(`Node.js ${INSTALLER_MINIMUM_NODE_MAJOR} or newer is required`);
  }
}

async function configurePackagedPlugin(stagingPath: string, version: string, mcpBinPath: string): Promise<void> {
  const manifestPath = join(stagingPath, "plugins/came/.codex-plugin/plugin.json");
  const manifest = await readJsonObject(manifestPath);
  manifest["version"] = version;
  await writeJsonAtomic(manifestPath, manifest);

  const mcpPath = join(stagingPath, "plugins/came/.mcp.json");
  const mcp = await readJsonObject(mcpPath);
  const servers = requireObject(mcp, "mcpServers", mcpPath);
  const server = requireObject(servers, "came-control", mcpPath);
  server["command"] = mcpBinPath;
  await writeJsonAtomic(mcpPath, mcp);
}

async function writeMarketplace(path: string): Promise<void> {
  await writeJsonAtomic(path, {
    name: CAME_MARKETPLACE_NAME,
    interface: { displayName: "CaMe" },
    plugins: [{
      name: "came",
      source: { source: "local", path: "./current/plugins/came" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  });
}

async function writeLauncher(path: string, modulePath: string): Promise<void> {
  const moduleUrl = pathToFileURL(modulePath).href;
  const content = `#!/usr/bin/env node\nimport { main } from ${JSON.stringify(moduleUrl)};\nmain(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; }, (error) => { process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n"); process.exitCode = 1; });\n`;
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, path);
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await symlink(target, temporaryPath);
  await rename(temporaryPath, path);
}

async function acquireInstallLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CaMeInstallerError(`Another CaMe installation is already using ${path}`);
    }
    throw error;
  }
}

function assertReplaceableLauncher(snapshot: PathSnapshot, path: string, expectedModule: string): void {
  if (snapshot.kind === "absent") {
    return;
  }
  const value = snapshot.kind === "file" ? snapshot.content.toString("utf8") : snapshot.target;
  if (!value.includes(expectedModule)) {
    throw new CaMeInstallerError(`Refusing to replace unmanaged executable ${path}`);
  }
}

async function verifyTargetPlugin(
  runCommand: InstallerCommandRunner,
  commandOptions: InstallerCommandOptions,
  expectedVersion: string,
): Promise<void> {
  const plugins = parsePluginInventory(
    (await runCommand("codex", ["plugin", "list", "--available", "--json"], commandOptions)).stdout,
  );
  const target = plugins.find((plugin) => plugin.pluginId === CAME_PLUGIN_ID);
  if (target === undefined || !target.installed || !target.enabled || target.version !== expectedVersion) {
    throw new CaMeInstallerError(`Codex did not activate ${CAME_PLUGIN_ID} version ${expectedVersion}`);
  }
}

function parseMarketplaceInventory(stdout: string): Array<{ name: string; source: string }> {
  const payload = parseJsonObject(stdout, "Codex marketplace inventory");
  const value = payload["marketplaces"];
  if (!Array.isArray(value)) {
    throw new CaMeInstallerError("Codex marketplace inventory does not contain a marketplaces array");
  }
  return value.flatMap((item) => {
    if (!isObject(item) || typeof item["name"] !== "string") {
      return [];
    }
    const marketplaceSource = item["marketplaceSource"];
    const source = isObject(marketplaceSource) && typeof marketplaceSource["source"] === "string"
      ? marketplaceSource["source"]
      : typeof item["root"] === "string" ? item["root"] : undefined;
    return source === undefined ? [] : [{ name: item["name"], source }];
  });
}

function parsePluginInventory(stdout: string): InstalledPlugin[] {
  const payload = parseJsonObject(stdout, "Codex plugin inventory");
  const installed = payload["installed"];
  if (!Array.isArray(installed)) {
    throw new CaMeInstallerError("Codex plugin inventory does not contain an installed array");
  }
  return installed.flatMap((item) => {
    if (!isObject(item) || typeof item["pluginId"] !== "string" || typeof item["name"] !== "string") {
      return [];
    }
    const source = item["source"];
    const marketplaceSource = item["marketplaceSource"];
    return [{
      pluginId: item["pluginId"],
      name: item["name"],
      ...(typeof item["version"] === "string" ? { version: item["version"] } : {}),
      installed: item["installed"] === true,
      enabled: item["enabled"] === true,
      ...(isObject(source) && typeof source["path"] === "string" ? { sourcePath: source["path"] } : {}),
      ...(isObject(marketplaceSource) && typeof marketplaceSource["source"] === "string"
        ? { marketplaceSource: marketplaceSource["source"] }
        : {}),
    }];
  });
}

function isManagedLegacyPlugin(plugin: InstalledPlugin, sourceRoot: string): boolean {
  return (plugin.marketplaceSource !== undefined && resolve(plugin.marketplaceSource) === sourceRoot)
    || (plugin.sourcePath !== undefined && isWithin(resolve(plugin.sourcePath), sourceRoot));
}

function isWithin(path: string, parent: string): boolean {
  const relationship = relative(parent, path);
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship));
}

async function snapshotPath(path: string): Promise<PathSnapshot> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return { kind: "symlink", target: await readlink(path) };
    }
    if (stats.isFile()) {
      return { kind: "file", content: await readFile(path), mode: stats.mode & 0o777 };
    }
    throw new CaMeInstallerError(`Refusing to modify unsupported filesystem entry ${path}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
}

async function restorePath(path: string, snapshot: PathSnapshot): Promise<void> {
  await rm(path, { force: true, recursive: false });
  if (snapshot.kind === "absent") {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  if (snapshot.kind === "symlink") {
    await symlink(snapshot.target, path);
    return;
  }
  await writeFile(path, snapshot.content, { mode: snapshot.mode });
  await chmod(path, snapshot.mode);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function requireReadableFile(path: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
  } catch (error) {
    throw new CaMeInstallerError(`Required installation artifact is missing: ${path}`, { cause: error });
  }
}

async function readJsonObject(path: string): Promise<JsonObject> {
  return parseJsonObject(await readFile(path, "utf8"), path);
}

function parseJsonObject(value: string, description: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CaMeInstallerError(`${description} is not valid JSON`, { cause: error });
  }
  if (!isObject(parsed)) {
    throw new CaMeInstallerError(`${description} must contain a JSON object`);
  }
  return parsed;
}

function requireObject(object: JsonObject, key: string, path: string): JsonObject {
  const value = object[key];
  if (!isObject(value)) {
    throw new CaMeInstallerError(`${path} does not contain object '${key}'`);
  }
  return value;
}

function requireString(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CaMeInstallerError(`${path} does not contain string '${key}'`);
  }
  return value;
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new CaMeInstallerError(`Missing required environment variable ${name}`);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function attemptRollback(operation: () => Promise<void>, errors: Error[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(toError(error));
  }
}
