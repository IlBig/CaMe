#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { installCaMe } from "../install/installer.js";

export async function main(args: string[]): Promise<number> {
  const sourceRoot = args[1];
  if (args.length !== 2 || args[0] !== "--source-root" || sourceRoot === undefined || sourceRoot.trim() === "") {
    process.stderr.write("Usage: came-install --source-root <path>\n");
    return 2;
  }
  const result = await installCaMe({ sourceRoot });
  process.stdout.write([
    `CaMe ${result.version} installed`,
    `Runtime: ${result.releasePath}`,
    `Commands: ${result.binDir}/came, ${result.binDir}/came-mcp`,
    `Plugin: came@${result.marketplaceName}`,
    ...(result.migratedPluginIds.length === 0
      ? []
      : [`Migrated: ${result.migratedPluginIds.join(", ")}`]),
    "Run `came` to start Codex with autonomous routing.",
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
