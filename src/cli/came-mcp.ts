#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runControlMcpServer } from "../mcp/control-server.js";

export async function main(args: string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write("Usage: came-mcp\n");
    return 2;
  }
  await runControlMcpServer();
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
