#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { SessionRuntime } from "../runtime/session-runtime.js";

export async function main(args: string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write("Usage: came\n");
    return 2;
  }

  const runtime = new SessionRuntime();
  const stopOnSignal = (signal: NodeJS.Signals): void => {
    runtime.requestStop(signal);
  };
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);

  try {
    return await runtime.run();
  } finally {
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
  }
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
