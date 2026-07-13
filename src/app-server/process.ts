import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";

import { AppServerBridge } from "./app-server-bridge.js";
import { AppServerConnectionClosedError } from "./protocol.js";

export type SpawnAppServerOptions = {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  stderr?: Writable;
};

export type SpawnedAppServer = {
  child: ChildProcessWithoutNullStreams;
  bridge: AppServerBridge;
};

export function spawnCodexAppServer(options: SpawnAppServerOptions = {}): SpawnedAppServer {
  const child = spawn(options.command ?? "codex", ["app-server", "--stdio"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridge = new AppServerBridge(child.stdout, child.stdin, options.requestTimeoutMs);
  child.stderr.pipe(options.stderr ?? process.stderr, { end: false });

  child.once("error", (error) => {
    bridge.close(new AppServerConnectionClosedError("Failed to start Codex App Server", { cause: error }));
  });
  child.once("exit", (code, signal) => {
    bridge.close(new AppServerConnectionClosedError(`Codex App Server exited with code ${String(code)} and signal ${String(signal)}`));
  });

  return { child, bridge };
}
