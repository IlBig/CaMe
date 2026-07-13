import type { Readable, Writable } from "node:stream";

import { z, type ZodType } from "zod";

import { JsonLineChannel } from "./json-line-channel.js";
import {
  AppServerConnectionClosedError,
  AppServerProtocolError,
  AppServerRequestError,
  AppServerTimeoutError,
  type CodexModel,
  type CodexTurn,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type RequestId,
  type ThreadSettingsUpdateParams,
  type TurnStartParams,
  isJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  initializeParamsSchema,
  initializeResponseSchema,
  modelListResponseSchema,
  parseJsonRpcMessage,
  threadSettingsUpdateParamsSchema,
  turnStartParamsSchema,
  turnStartResponseSchema,
} from "./protocol.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_PENDING_PROXY_REQUESTS = 1_024;
export const MAX_MODEL_PAGES = 100;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ForwardedTuiRequest = {
  clientId: RequestId;
  method: string;
};

type ClientMessageListener = (message: JsonRpcMessage) => void;
type NotificationListener = (notification: JsonRpcNotification) => void;
type CloseListener = (error: Error) => void;

export class AppServerBridge {
  readonly #channel: JsonLineChannel;
  readonly #requestTimeoutMs: number;
  readonly #pendingRequests = new Map<RequestId, PendingRequest>();
  readonly #tuiRequests = new Map<RequestId, ForwardedTuiRequest>();
  readonly #serverRequestIds = new Map<RequestId, RequestId>();
  readonly #clientMessageListeners = new Set<ClientMessageListener>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #closeListeners = new Set<CloseListener>();
  #nextId = 1n;
  #closedError: Error | null = null;
  #initializationAttempted = false;
  #initializationAccepted = false;
  #initialized = false;

  public constructor(input: Readable, output: Writable, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive safe integer");
    }

    this.#requestTimeoutMs = requestTimeoutMs;
    this.#channel = new JsonLineChannel(input, output);
    this.#channel.onMessage((message) => this.#handleServerMessage(message));
    this.#channel.onClose((error) => this.#close(error));
  }

  public onClientMessage(listener: ClientMessageListener): () => void {
    this.#clientMessageListeners.add(listener);
    return () => this.#clientMessageListeners.delete(listener);
  }

  public onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onClose(listener: CloseListener): () => void {
    if (this.#closedError !== null) {
      listener(this.#closedError);
      return () => undefined;
    }

    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public async initialize(clientVersion: string): Promise<void> {
    this.#reserveInitialization();

    await this.#request("initialize", {
      clientInfo: {
        name: "came",
        title: "CaMe",
        version: clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    }, initializeResponseSchema);
    this.#initializationAccepted = true;
    await this.#notify("initialized");
    this.#initialized = true;
  }

  public get isInitialized(): boolean {
    return this.#initialized;
  }

  public async listModels(): Promise<CodexModel[]> {
    this.#assertInitialized();
    const models: CodexModel[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      pages += 1;
      if (pages > MAX_MODEL_PAGES) {
        this.#failProtocol("Codex App Server exceeded the model pagination limit");
      }
      const params: { cursor?: string } = cursor === null ? {} : { cursor };
      const response: z.infer<typeof modelListResponseSchema> = await this.#request("model/list", params, modelListResponseSchema);
      models.push(...response.data);
      cursor = response.nextCursor ?? null;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          this.#failProtocol("Codex App Server returned a repeated model pagination cursor");
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== null);

    return models;
  }

  public async updateThreadSettings(params: ThreadSettingsUpdateParams): Promise<void> {
    this.#assertInitialized();
    await this.#request("thread/settings/update", threadSettingsUpdateParamsSchema.parse(params), z.object({}).passthrough());
  }

  public async startTurn(params: TurnStartParams): Promise<CodexTurn> {
    this.#assertInitialized();
    const response = await this.#request("turn/start", turnStartParamsSchema.parse(params), turnStartResponseSchema);
    return response.turn;
  }

  async #request<T>(method: string, params: unknown, responseSchema: ZodType<T>): Promise<T> {
    this.#assertOpen();
    if (method.trim() === "") {
      throw new AppServerProtocolError("JSON-RPC request method must not be empty");
    }
    if (this.#pendingRequests.size >= MAX_PENDING_PROXY_REQUESTS) {
      throw new AppServerProtocolError("Too many pending controller requests");
    }
    const id = `came:${this.#nextId++}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#channel.close(new AppServerTimeoutError(method, this.#requestTimeoutMs));
      }, this.#requestTimeoutMs);
      this.#pendingRequests.set(id, { resolve, reject, timeout });
    });

    try {
      await this.#channel.send({ id, method, params });
    } catch (error) {
      const pending = this.#pendingRequests.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.#pendingRequests.delete(id);
        pending.reject(error instanceof Error ? error : new AppServerConnectionClosedError());
      }
    }

    const result = await response;
    try {
      return responseSchema.parse(result);
    } catch (error) {
      const protocolError = new AppServerProtocolError(`Invalid response payload for '${method}'`, { cause: error });
      this.#channel.close(protocolError);
      throw protocolError;
    }
  }

  #notify(method: string, params?: unknown): Promise<void> {
    this.#assertOpen();
    if (method.trim() === "") {
      throw new AppServerProtocolError("JSON-RPC notification method must not be empty");
    }
    return this.#channel.send(params === undefined ? { method } : { method, params });
  }

  public async forwardClientMessage(value: unknown): Promise<void> {
    this.#assertOpen();
    const message = parseJsonRpcMessage(value);

    if (isJsonRpcRequest(message)) {
      if (this.#tuiRequests.size >= MAX_PENDING_PROXY_REQUESTS) {
        throw new AppServerProtocolError("Too many pending TUI requests");
      }
      if (message.method === "initialize") {
        this.#reserveInitialization();
      }
      const internalId = `tui:${this.#nextId++}`;
      const outboundMessage = message.method === "initialize"
        ? {
            ...message,
            id: internalId,
            params: this.#withExperimentalApi(message.params),
          }
        : { ...message, id: internalId };
      this.#tuiRequests.set(internalId, { clientId: message.id, method: message.method });
      try {
        await this.#channel.send(outboundMessage);
      } catch (error) {
        this.#tuiRequests.delete(internalId);
        throw error;
      }
      return;
    }

    if (isJsonRpcResponse(message) || isJsonRpcError(message)) {
      const serverId = this.#serverRequestIds.get(message.id);
      if (serverId === undefined) {
        throw new AppServerProtocolError("TUI response does not match a pending App Server request");
      }
      this.#serverRequestIds.delete(message.id);
      await this.#channel.send({ ...message, id: serverId });
      return;
    }

    if (isJsonRpcNotification(message) && message.method === "initialized") {
      if (!this.#initializationAccepted || this.#initialized) {
        throw new AppServerProtocolError("TUI initialized notification is out of sequence");
      }
      await this.#channel.send(message);
      this.#initialized = true;
      return;
    }

    await this.#channel.send(message);
  }

  public close(error = new AppServerConnectionClosedError()): void {
    this.#channel.close(error);
  }

  #handleServerMessage(message: JsonRpcMessage): void {
    if (isJsonRpcNotification(message)) {
      for (const listener of this.#notificationListeners) {
        listener(message);
      }
      this.#emitClientMessage(message);
      return;
    }

    if (isJsonRpcRequest(message)) {
      if (this.#serverRequestIds.size >= MAX_PENDING_PROXY_REQUESTS) {
        this.#channel.close(new AppServerProtocolError("Too many pending App Server requests"));
        return;
      }
      const proxyId = `server:${this.#nextId++}`;
      this.#serverRequestIds.set(proxyId, message.id);
      this.#emitClientMessage({ ...message, id: proxyId });
      return;
    }

    const pending = this.#pendingRequests.get(message.id);
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      this.#pendingRequests.delete(message.id);
      if (isJsonRpcError(message)) {
        pending.reject(new AppServerRequestError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const tuiRequest = this.#tuiRequests.get(message.id);
    if (tuiRequest !== undefined) {
      this.#tuiRequests.delete(message.id);
      if (tuiRequest.method === "initialize" && isJsonRpcResponse(message)) {
        try {
          initializeResponseSchema.parse(message.result);
          this.#initializationAccepted = true;
        } catch (error) {
          this.#channel.close(new AppServerProtocolError("Invalid TUI initialization response", { cause: error }));
          return;
        }
      }
      this.#emitClientMessage({ ...message, id: tuiRequest.clientId });
      return;
    }

    this.#channel.close(new AppServerProtocolError("App Server response does not match a pending request"));
  }

  #emitClientMessage(message: JsonRpcMessage): void {
    for (const listener of this.#clientMessageListeners) {
      listener(message);
    }
  }

  #assertOpen(): void {
    if (this.#closedError !== null) {
      throw this.#closedError;
    }
  }

  #assertInitialized(): void {
    this.#assertOpen();
    if (!this.#initialized) {
      throw new AppServerProtocolError("Codex App Server is not initialized");
    }
  }

  #reserveInitialization(): void {
    if (this.#initializationAttempted) {
      throw new AppServerProtocolError("Codex App Server initialization can only be attempted once");
    }
    this.#initializationAttempted = true;
  }

  #withExperimentalApi(params: unknown): unknown {
    const parsed = initializeParamsSchema.parse(params);
    return {
      ...parsed,
      capabilities: {
        ...(parsed.capabilities ?? {}),
        experimentalApi: true,
      },
    };
  }

  #failProtocol(message: string): never {
    const error = new AppServerProtocolError(message);
    this.#channel.close(error);
    throw error;
  }

  #close(error: Error): void {
    if (this.#closedError !== null) {
      return;
    }

    this.#closedError = error;
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
    this.#tuiRequests.clear();
    this.#serverRequestIds.clear();
    this.#clientMessageListeners.clear();
    this.#notificationListeners.clear();
    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    const listenerErrors: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener(error);
      } catch (listenerError) {
        listenerErrors.push(listenerError);
      }
    }
    if (listenerErrors.length > 0) {
      throw new AggregateError(listenerErrors, "App Server bridge close listeners failed");
    }
  }
}
