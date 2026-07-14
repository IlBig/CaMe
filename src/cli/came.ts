#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  formatDiagnosticReport,
  runDiagnostics,
  type DiagnosticReport,
} from "../diagnostics/doctor.js";
import { SessionRuntime } from "../runtime/session-runtime.js";

export type CameCliDependencies = Readonly<{
  runDiagnostics?: () => Promise<DiagnosticReport>;
}>;

export async function main(args: string[], dependencies: CameCliDependencies = {}): Promise<number> {
  if (args[0] === "doctor") {
    const doctorArgs = args.slice(1);
    if (doctorArgs.length > 1 || (doctorArgs.length === 1 && doctorArgs[0] !== "--json")) {
      process.stderr.write("Usage: came [doctor [--json]]\n");
      return 2;
    }
    const report = await (dependencies.runDiagnostics ?? runDiagnostics)();
    process.stdout.write(doctorArgs[0] === "--json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatDiagnosticReport(report));
    return report.ready ? 0 : 1;
  }
  if (args.length > 0) {
    process.stderr.write("Usage: came [doctor [--json]]\n");
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
