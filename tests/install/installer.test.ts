import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAME_MARKETPLACE_NAME,
  CAME_PLUGIN_ID,
  installCaMe,
  type InstallerCommandRunner,
} from "../../src/install/installer.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("CaMe installer", () => {
  it("installs a production runtime, registers the plugin, and migrates the repo-local plugin", async () => {
    const fixture = await createFixture();
    const harness = createCommandHarness(fixture, [{
      pluginId: "came@personal",
      name: "came",
      version: "0.1.0+codex.previous",
      installed: true,
      enabled: true,
      source: { source: "local", path: join(fixture.sourceRoot, "plugins/came") },
      marketplaceSource: { sourceType: "local", source: fixture.sourceRoot },
    }]);

    const result = await installCaMe({
      sourceRoot: fixture.sourceRoot,
      dataRoot: fixture.dataRoot,
      binDir: fixture.binDir,
      cachebuster: "20260715160000",
      env: { HOME: fixture.home, PATH: process.env["PATH"] },
      packageManager: { command: "pnpm", argsPrefix: [] },
      runCommand: harness.runCommand,
    });

    expect(result.version).toBe("0.1.0+codex.20260715160000");
    expect(result.migratedPluginIds).toEqual(["came@personal"]);
    expect(await readlink(join(fixture.dataRoot, "current"))).toContain("releases/0.1.0-20260715160000-");
    expect(await readFile(join(fixture.binDir, "came"), "utf8")).toContain(result.releasePath);
    expect(await readFile(join(fixture.binDir, "came-mcp"), "utf8")).toContain(result.releasePath);

    const packagedManifest = JSON.parse(await readFile(
      join(result.releasePath, "plugins/came/.codex-plugin/plugin.json"),
      "utf8",
    )) as { version: string };
    const packagedMcp = JSON.parse(await readFile(
      join(result.releasePath, "plugins/came/.mcp.json"),
      "utf8",
    )) as { mcpServers: { "came-control": { command: string } } };
    const marketplace = JSON.parse(await readFile(
      join(fixture.dataRoot, ".agents/plugins/marketplace.json"),
      "utf8",
    )) as { name: string; plugins: Array<{ source: { path: string } }> };

    expect(packagedManifest.version).toBe(result.version);
    expect(packagedMcp.mcpServers["came-control"].command).toBe(join(fixture.binDir, "came-mcp"));
    expect(marketplace).toMatchObject({
      name: CAME_MARKETPLACE_NAME,
      plugins: [{ source: { path: "./current/plugins/came" } }],
    });
    expect(harness.installedPlugins.map((plugin) => plugin.pluginId)).toEqual([CAME_PLUGIN_ID]);
  });

  it("restores the previous runtime and launchers when Codex rejects plugin installation", async () => {
    const fixture = await createFixture();
    const previousRelease = join(fixture.dataRoot, "releases/previous");
    await mkdir(previousRelease, { recursive: true });
    await symlink("releases/previous", join(fixture.dataRoot, "current"));
    await mkdir(fixture.binDir, { recursive: true });
    await writeFile(join(fixture.binDir, "came"), "/previous/dist/cli/came.js\n", { mode: 0o755 });
    await writeFile(join(fixture.binDir, "came-mcp"), "/previous/dist/cli/came-mcp.js\n", { mode: 0o755 });
    const harness = createCommandHarness(fixture, [], true);

    await expect(installCaMe({
      sourceRoot: fixture.sourceRoot,
      dataRoot: fixture.dataRoot,
      binDir: fixture.binDir,
      cachebuster: "20260715160100",
      env: { HOME: fixture.home, PATH: process.env["PATH"] },
      packageManager: { command: "pnpm", argsPrefix: [] },
      runCommand: harness.runCommand,
    })).rejects.toThrow("plugin install rejected");

    expect(await readlink(join(fixture.dataRoot, "current"))).toBe("releases/previous");
    expect(await readFile(join(fixture.binDir, "came"), "utf8")).toBe("/previous/dist/cli/came.js\n");
    expect(await readFile(join(fixture.binDir, "came-mcp"), "utf8")).toBe("/previous/dist/cli/came-mcp.js\n");
    expect(harness.marketplaceConfigured).toBe(false);
    expect(harness.installedPlugins).toEqual([]);
  });

  it("fails closed when another installation owns the lock", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dataRoot, { recursive: true });
    await writeFile(join(fixture.dataRoot, ".install.lock"), "busy\n");
    const harness = createCommandHarness(fixture, []);

    await expect(installCaMe({
      sourceRoot: fixture.sourceRoot,
      dataRoot: fixture.dataRoot,
      binDir: fixture.binDir,
      cachebuster: "20260715160200",
      env: { HOME: fixture.home, PATH: process.env["PATH"] },
      packageManager: { command: "pnpm", argsPrefix: [] },
      runCommand: harness.runCommand,
    })).rejects.toThrow("Another CaMe installation");

    expect(harness.installedPlugins).toEqual([]);
  });
});

type Fixture = Readonly<{
  home: string;
  sourceRoot: string;
  dataRoot: string;
  binDir: string;
}>;

type PluginRecord = {
  pluginId: string;
  name: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  source: { source: string; path: string };
  marketplaceSource: { sourceType: string; source: string };
};

async function createFixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "came-installer-test-"));
  temporaryRoots.push(home);
  const sourceRoot = join(home, "source");
  const dataRoot = join(home, "data");
  const binDir = join(home, "bin");
  await Promise.all([
    mkdir(join(sourceRoot, "dist/cli"), { recursive: true }),
    mkdir(join(sourceRoot, "plugins/came/.codex-plugin"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceRoot, "dist/cli/came.js"), "export async function main() { return 0; }\n"),
    writeFile(join(sourceRoot, "dist/cli/came-mcp.js"), "export async function main() { return 0; }\n"),
    writeFile(join(sourceRoot, "package.json"), JSON.stringify({ name: "came", version: "0.1.0" })),
    writeFile(join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    writeFile(join(sourceRoot, "plugins/came/.codex-plugin/plugin.json"), JSON.stringify({
      name: "came",
      version: "0.1.0+codex.previous",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    })),
    writeFile(join(sourceRoot, "plugins/came/.mcp.json"), JSON.stringify({
      mcpServers: {
        "came-control": {
          type: "stdio",
          command: "came-mcp",
          env_vars: ["CAME_CONTROL_SOCKET", "CAME_CONTROL_TOKEN", "CAME_SESSION_ID"],
        },
      },
    })),
  ]);
  return { home, sourceRoot: resolve(sourceRoot), dataRoot: resolve(dataRoot), binDir: resolve(binDir) };
}

function createCommandHarness(fixture: Fixture, initialPlugins: PluginRecord[], rejectTargetInstall = false): {
  runCommand: InstallerCommandRunner;
  installedPlugins: PluginRecord[];
  readonly marketplaceConfigured: boolean;
} {
  const installedPlugins = [...initialPlugins];
  let marketplaceConfigured = false;
  let rejectNextTargetInstall = rejectTargetInstall;

  const runCommand: InstallerCommandRunner = async (command, args) => {
    if (command === "pnpm") {
      const directoryIndex = args.indexOf("--dir");
      const directory = args[directoryIndex + 1];
      if (directory === undefined) {
        throw new Error("missing --dir");
      }
      await Promise.all([
        writePackage(directory, "@modelcontextprotocol/sdk"),
        writePackage(directory, "ws"),
        writePackage(directory, "zod"),
      ]);
      return { stdout: "", stderr: "" };
    }
    if (command === "codex" && args[0] === "--version") {
      return { stdout: "codex-cli 0.144.3\n", stderr: "" };
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
      return {
        stdout: JSON.stringify({
          marketplaces: marketplaceConfigured ? [{
            name: CAME_MARKETPLACE_NAME,
            root: fixture.dataRoot,
            marketplaceSource: { sourceType: "local", source: fixture.dataRoot },
          }] : [],
        }),
        stderr: "",
      };
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      marketplaceConfigured = true;
      return { stdout: "{}", stderr: "" };
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
      marketplaceConfigured = false;
      return { stdout: "{}", stderr: "" };
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "list") {
      return { stdout: JSON.stringify({ installed: installedPlugins, available: [] }), stderr: "" };
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "add") {
      const pluginId = args[2];
      if (pluginId === CAME_PLUGIN_ID && rejectNextTargetInstall) {
        rejectNextTargetInstall = false;
        throw new Error("plugin install rejected");
      }
      if (pluginId === undefined) {
        throw new Error("missing plugin id");
      }
      if (pluginId === CAME_PLUGIN_ID) {
        const manifest = JSON.parse(await readFile(
          join(fixture.dataRoot, "current/plugins/came/.codex-plugin/plugin.json"),
          "utf8",
        )) as { version: string };
        replacePlugin(installedPlugins, {
          pluginId,
          name: "came",
          version: manifest.version,
          installed: true,
          enabled: true,
          source: { source: "local", path: join(fixture.dataRoot, "current/plugins/came") },
          marketplaceSource: { sourceType: "local", source: fixture.dataRoot },
        });
      }
      return { stdout: "{}", stderr: "" };
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "remove") {
      const pluginId = args[2];
      const index = installedPlugins.findIndex((plugin) => plugin.pluginId === pluginId);
      if (index >= 0) {
        installedPlugins.splice(index, 1);
      }
      return { stdout: "{}", stderr: "" };
    }
    if (command === join(fixture.binDir, "came") && args[0] === "doctor") {
      return { stdout: JSON.stringify({ ready: true, checks: [] }), stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  return {
    runCommand,
    installedPlugins,
    get marketplaceConfigured() {
      return marketplaceConfigured;
    },
  };
}

async function writePackage(root: string, name: string): Promise<void> {
  const path = join(root, "node_modules", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name }));
}

function replacePlugin(plugins: PluginRecord[], plugin: PluginRecord): void {
  const index = plugins.findIndex((candidate) => candidate.pluginId === plugin.pluginId);
  if (index >= 0) {
    plugins.splice(index, 1, plugin);
    return;
  }
  plugins.push(plugin);
}
