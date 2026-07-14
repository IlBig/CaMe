import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { AppServerBridge } from "../app-server/app-server-bridge.js";
import {
  isJsonRpcRequest,
  parseJsonRpcMessage,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "../app-server/protocol.js";
import type {
  ExplicitProfileRequest,
  ExplicitProfileResult,
  ModelProfile,
} from "../contracts.js";

export const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_EXPLICIT_PROFILE_COMMAND_LENGTH = 256;

const EXPLICIT_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
]);
const EXPLICIT_PROFILE_LINE_SEPARATOR = /[\r\n\u2028\u2029]/u;

export type ExplicitProfileHandler = (request: ExplicitProfileRequest) => Promise<ExplicitProfileResult>;

type ConnectionWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class SessionGatewayError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionGatewayError";
  }
}

export class SessionGatewayDisconnectedError extends SessionGatewayError {
  public constructor() {
    super("TUI WebSocket closed unexpectedly");
    this.name = "SessionGatewayDisconnectedError";
  }
}

export class WebSocketGateway {
  readonly #bridge: AppServerBridge;
  readonly #authToken: string;
  readonly #fatalListener: (error: Error) => void;
  readonly #explicitProfileHandler: ExplicitProfileHandler | undefined;
  readonly #connectionWaiters = new Set<ConnectionWaiter>();
  #server: WebSocketServer | null = null;
  #client: WebSocket | null = null;
  #bridgeUnsubscribe: (() => void) | null = null;
  #receiveQueue: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;
  #started = false;
  #closing = false;
  #failed = false;

  public constructor(
    bridge: AppServerBridge,
    authToken: string,
    fatalListener: (error: Error) => void,
    explicitProfileHandler?: ExplicitProfileHandler,
  ) {
    if (authToken.length < 32) {
      throw new RangeError("Gateway authentication token must contain at least 32 characters");
    }
    this.#bridge = bridge;
    this.#authToken = authToken;
    this.#fatalListener = fatalListener;
    this.#explicitProfileHandler = explicitProfileHandler;
  }

  public async start(): Promise<string> {
    if (this.#started) {
      throw new SessionGatewayError("WebSocket gateway can only be started once");
    }
    this.#started = true;

    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES,
      verifyClient: ({ req }: { req: IncomingMessage }) => this.#isAuthorized(req.headers.authorization),
    });
    this.#server = server;
    server.on("connection", (client) => this.#acceptClient(client));

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onStartupError);
        resolve();
      };
      const onStartupError = (error: Error): void => {
        server.off("listening", onListening);
        reject(new SessionGatewayError("WebSocket gateway could not listen", { cause: error }));
      };
      server.once("listening", onListening);
      server.once("error", onStartupError);
    });
    server.on("error", (error) => this.#fail(new SessionGatewayError("WebSocket gateway failed", { cause: error })));

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new SessionGatewayError("WebSocket gateway returned an invalid listen address");
    }

    this.#bridgeUnsubscribe = this.#bridge.onClientMessage((message) => this.#sendToClient(message));
    return `ws://127.0.0.1:${address.port}`;
  }

  public waitForClient(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError("Gateway client timeout must be a positive safe integer"));
    }
    if (!this.#started || this.#server === null) {
      return Promise.reject(new SessionGatewayError("WebSocket gateway has not started"));
    }
    if (this.#client?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.#closing || this.#failed) {
      return Promise.reject(new SessionGatewayError("WebSocket gateway is not available"));
    }

    return new Promise((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.#connectionWaiters.delete(waiter);
          reject(new SessionGatewayError(`TUI did not connect within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.#connectionWaiters.add(waiter);
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    this.#rejectConnectionWaiters(new SessionGatewayError("WebSocket gateway closed"));
    this.#client?.terminate();
    this.#client = null;

    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(new SessionGatewayError("WebSocket gateway could not close", { cause: error }));
        });
      });
    }
  }

  #acceptClient(client: WebSocket): void {
    if (this.#closing || this.#client !== null) {
      client.close(1008, "A CaMe session accepts one TUI client");
      return;
    }

    this.#client = client;
    client.on("message", (data, isBinary) => {
      this.#receiveQueue = this.#receiveQueue
        .then(() => this.#handleClientMessage(data, isBinary))
        .catch((error: unknown) => {
          this.#fail(new SessionGatewayError("Invalid TUI WebSocket message", {
            cause: error instanceof Error ? error : undefined,
          }));
        });
    });
    client.once("error", (error) => this.#fail(new SessionGatewayError("TUI WebSocket failed", { cause: error })));
    client.once("close", () => {
      if (!this.#closing) {
        this.#fail(new SessionGatewayDisconnectedError());
      }
    });
    this.#resolveConnectionWaiters();
  }

  async #handleClientMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.#failed || this.#closing) {
      return;
    }
    if (isBinary) {
      throw new AppServerMessageError("Binary TUI messages are not supported");
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data).toString("utf8");
    const value: unknown = JSON.parse(text);
    const message = parseJsonRpcMessage(value);
    if (isJsonRpcRequest(message) && message.method === "turn/start") {
      const intercepted = await this.#interceptExplicitProfileCommand(message);
      if (intercepted) {
        return;
      }
    }
    await this.#bridge.forwardClientMessage(message);
  }

  async #interceptExplicitProfileCommand(message: JsonRpcRequest): Promise<boolean> {
    const startedAtMs = Date.now();
    const inspection = inspectExplicitProfileCommand(message);
    if (inspection.status === "not_command") {
      return false;
    }
    if (inspection.status === "invalid") {
      this.#sendRequestError(message.id, -32602, inspection.message);
      return true;
    }
    if (this.#explicitProfileHandler === undefined) {
      this.#sendRequestError(message.id, -32040, "CaMe explicit profile routing is unavailable");
      return true;
    }

    const result = await this.#explicitProfileHandler(inspection.request);
    if (result.status === "rejected") {
      this.#sendRequestError(message.id, -32040, result.message, { cameCode: result.code });
      return true;
    }
    if (!isSafeProfileToken(result.profile.model)
      || !EXPLICIT_EFFORTS.has(result.profile.effort)
      || result.profile.effort !== inspection.request.effort) {
      this.#sendRequestError(message.id, -32040, "CaMe returned an invalid explicit profile");
      return true;
    }
    this.#sendExplicitProfileCompletion(
      message.id,
      inspection.request.threadId,
      result.profile,
      startedAtMs,
    );
    return true;
  }

  #sendExplicitProfileCompletion(
    id: JsonRpcRequest["id"],
    threadId: string,
    profile: ModelProfile,
    startedAtMs: number,
  ): void {
    const completedAtMs = Date.now();
    const turnId = randomUUID();
    const itemId = randomUUID();
    const startedAt = Math.floor(startedAtMs / 1_000);
    const completedAt = Math.floor(completedAtMs / 1_000);
    const initialTurn = {
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
    const startedTurn = {
      ...initialTurn,
      startedAt,
    };
    const item = {
      type: "agentMessage",
      id: itemId,
      text: `Profilo attivo: ${profile.model}/${profile.effort}.`,
      phase: "final_answer",
      memoryCitation: null,
    };
    const completedTurn = {
      ...startedTurn,
      status: "completed",
      completedAt,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
    };

    this.#sendToClient({ id, result: { turn: initialTurn } });
    this.#sendToClient({ method: "turn/started", params: { threadId, turn: startedTurn } });
    this.#sendToClient({ method: "item/started", params: { threadId, turnId, item, startedAtMs } });
    this.#sendToClient({ method: "item/completed", params: { threadId, turnId, item, completedAtMs } });
    this.#sendToClient({ method: "turn/completed", params: { threadId, turn: completedTurn } });
  }

  #sendRequestError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): void {
    this.#sendToClient({
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    });
  }

  #sendToClient(message: JsonRpcMessage): void {
    const client = this.#client;
    if (client === null || client.readyState !== WebSocket.OPEN) {
      this.#fail(new SessionGatewayError("App Server emitted a message without a connected TUI"));
      return;
    }
    try {
      client.send(JSON.stringify(message), (error) => {
        if (error != null) {
          this.#fail(new SessionGatewayError("Could not send App Server message to TUI", { cause: error }));
        }
      });
    } catch (error) {
      this.#fail(new SessionGatewayError("Could not serialize App Server message for TUI", {
        cause: error instanceof Error ? error : undefined,
      }));
    }
  }

  #isAuthorized(authorization: string | undefined): boolean {
    if (authorization === undefined) {
      return false;
    }
    const expected = Buffer.from(`Bearer ${this.#authToken}`);
    const received = Buffer.from(authorization);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  #resolveConnectionWaiters(): void {
    for (const waiter of this.#connectionWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.#connectionWaiters.clear();
  }

  #rejectConnectionWaiters(error: Error): void {
    for (const waiter of this.#connectionWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#connectionWaiters.clear();
  }

  #fail(error: Error): void {
    if (this.#failed || this.#closing) {
      return;
    }
    this.#failed = true;
    this.#rejectConnectionWaiters(error);
    this.#client?.terminate();
    this.#fatalListener(error);
  }
}

class AppServerMessageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AppServerMessageError";
  }
}

type ExplicitCommandInspection =
  | Readonly<{ status: "not_command" }>
  | Readonly<{ status: "invalid"; message: string }>
  | Readonly<{ status: "command"; request: ExplicitProfileRequest }>;

type ParsedExplicitCommand =
  | Readonly<{ status: "not_command" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "command"; modelQuery: string; effort: string }>;

function inspectExplicitProfileCommand(message: JsonRpcRequest): ExplicitCommandInspection {
  if (!isRecord(message.params) || !Array.isArray(message.params["input"])) {
    return { status: "not_command" };
  }
  const input = message.params["input"];
  const parsedCommands = input
    .filter((item): item is Record<string, unknown> => isRecord(item) && item["type"] === "text" && typeof item["text"] === "string")
    .map((item) => parseExplicitProfileCommand(item["text"] as string))
    .filter((parsed) => parsed.status !== "not_command");
  if (parsedCommands.length === 0) {
    return { status: "not_command" };
  }
  if (input.length !== 1 || parsedCommands.length !== 1) {
    return { status: "invalid", message: "An explicit profile command must be the only turn input" };
  }
  const parsed = parsedCommands[0];
  if (parsed === undefined || parsed.status === "invalid") {
    return { status: "invalid", message: "Invalid explicit profile command" };
  }
  const threadId = message.params["threadId"];
  if (typeof threadId !== "string" || threadId.trim() === "") {
    return { status: "invalid", message: "An explicit profile command requires a thread id" };
  }
  return {
    status: "command",
    request: {
      threadId,
      modelQuery: parsed.modelQuery,
      effort: parsed.effort,
    },
  };
}

export function parseExplicitProfileCommand(text: string): ParsedExplicitCommand {
  const trimmed = text.trim();
  const prefix = /^(?:cambia|imposta)\s+(?:il\s+)?modello\b/iu.exec(trimmed)
    ?? /^(?:change|switch|set)\s+(?:the\s+)?model\b/iu.exec(trimmed);
  if (prefix === null) {
    return { status: "not_command" };
  }
  if (trimmed.length > MAX_EXPLICIT_PROFILE_COMMAND_LENGTH || EXPLICIT_PROFILE_LINE_SEPARATOR.test(trimmed)) {
    return { status: "invalid" };
  }
  const remainder = trimmed.slice(prefix[0].length)
    .replace(/^\s*(?:(?:in|a|su|to)\s+)?/iu, "")
    .replace(/[.!]$/u, "")
    .trim();
  const tokens = remainder.split(/\s+/u);
  if (tokens.length < 2) {
    return { status: "invalid" };
  }
  const effort = tokens.at(-1)?.toLowerCase();
  if (effort === undefined || !EXPLICIT_EFFORTS.has(effort)) {
    return { status: "invalid" };
  }
  const modelQuery = tokens.slice(0, -1).join(" ");
  if (modelQuery.length === 0 || modelQuery.length > 128) {
    return { status: "invalid" };
  }
  return { status: "command", modelQuery, effort };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeProfileToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}
