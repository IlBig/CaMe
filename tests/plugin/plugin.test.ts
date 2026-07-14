import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PLUGIN_ROOT = resolve(PROJECT_ROOT, "plugins/came");

type JsonObject = Record<string, unknown>;

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

describe("CaMe Codex plugin", () => {
  it("declares the plugin components and the package MCP executable", async () => {
    const manifest = await readJson(resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json"));
    const mcp = await readJson(resolve(PLUGIN_ROOT, ".mcp.json"));
    const packageJson = await readJson(resolve(PROJECT_ROOT, "package.json"));

    expect(manifest).toMatchObject({
      name: "came",
      version: "0.1.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "CaMe",
        category: "Productivity",
      },
    });
    expect(mcp).toEqual({
      mcpServers: {
        "came-control": {
          type: "stdio",
          command: "came-mcp",
        },
      },
    });
    expect(packageJson["bin"]).toMatchObject({
      "came-mcp": "./dist/cli/came-mcp.js",
    });
  });

  it("publishes one available repo-local marketplace entry", async () => {
    const marketplace = await readJson(resolve(PROJECT_ROOT, ".agents/plugins/marketplace.json"));

    expect(marketplace).toEqual({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [{
        name: "came",
        source: { source: "local", path: "./plugins/came" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    });
  });

  it("defines an autonomous same-thread routing workflow without terminal injection", async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, "skills/route-with-came/SKILL.md"), "utf8");
    const metadata = await readFile(resolve(PLUGIN_ROOT, "skills/route-with-came/agents/openai.yaml"), "utf8");
    const frontmatter = /^---\n(?<content>[\s\S]*?)\n---\n/u.exec(skill)?.groups?.["content"];

    expect(frontmatter?.split("\n").map((line) => line.split(":", 1)[0])).toEqual([
      "name",
      "description",
    ]);
    expect(skill).toContain("`came_session_state`");
    expect(skill).toContain("`came_switch_model`");
    expect(skill).toContain("`came_confirm_switch`");
    expect(skill).toContain("immediately following turn");
    expect(skill).toContain("Do not inject `/model`");
    expect(skill).toContain("Do not start or spawn another Codex session");
    expect(skill).not.toContain("[TODO:");
    expect(metadata).toContain('default_prompt: "Use $route-with-came');
  });
});
