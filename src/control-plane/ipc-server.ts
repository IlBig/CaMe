import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

import {
  DEFAULT_CONTROL_MAX_CONNECTIONS,
  DEFAULT_CONTROL_MAX_MESSAGE_BYTES,
  DEFAULT_CONTROL_MAX_REPLAY_ENTRIES,
  DEFAULT_CONTROL_REPLAY_TTL_MS,
  DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
  controlAuthTokenSchema,
  controlEnvelopeSchema,
  controlRequestSchema,
  controlResultSchemas,
  type ControlErrorCode,
  type ControlPlaneHandler,
  type ControlRequest,
  type ControlResponse,
} from "./protocol.js";

export type ControlPlaneServerOptions = {
  socketPath: string;
  sessionId: string;
  authToken: string;
  handler: ControlPlaneHandler;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxConnections?: number;
  replayTtlMs?: number;
  maxReplayEntries?: number;
  onFatalError?: (error: Error) => void;
};

export class ControlPlaneServerError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ControlPlaneServerError";
  }
}

export class ControlPlaneServer {
  readonly #options: Required<Pick<ControlPlaneServerOptions,
    "requestTimeoutMs" | "maxMessageBytes" | "maxConnections" | "replayTtlMs" | "maxReplayEntries">>
    & Omit<ControlPlaneServerOptions,
      "requestTimeoutMs" | "maxMessageBytes" | "maxConnections" | "replayTtlMs" | "maxReplayEntries">;
  readonly #tokenDigest: Buffer;
  readonly #sockets = new Set<Socket>();
  readonly #requestControllers = new Set<AbortController>();
  readonly #replayEntries = new Map<string, number>();
  #server: Server | null = null;
  #executionQueue: Promise<void> = Promise.resolve();
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #ownsSocket = false;
  #started = false;
  #closing = false;
  #failed = false;

  public constructor(options: ControlPlaneServerOptions) {
    validatePositiveInteger(options.requestTimeoutMs, "Control request timeout");
    validatePositiveInteger(options.maxMessageBytes, "Control message limit");
    validatePositiveInteger(options.maxConnections, "Control connection limit");
    validatePositiveInteger(options.replayTtlMs, "Control replay TTL");
    validatePositiveInteger(options.maxReplayEntries, "Control replay capacity");
    if (!isAbsolute(options.socketPath)) {
      throw new RangeError("Control socket path must be absolute");
    }
    z.uuid().parse(options.sessionId);
    controlAuthTokenSchema.parse(options.authToken);
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_CONTROL_MAX_MESSAGE_BYTES,
      maxConnections: options.maxConnections ?? DEFAULT_CONTROL_MAX_CONNECTIONS,
      replayTtlMs: options.replayTtlMs ?? DEFAULT_CONTROL_REPLAY_TTL_MS,
      maxReplayEntries: options.maxReplayEntries ?? DEFAULT_CONTROL_MAX_REPLAY_ENTRIES,
    };
    this.#tokenDigest = digestToken(options.authToken);
  }

  public async start(): Promise<void> {
    if (this.#started || this.#closing) {
      throw new ControlPlaneServerError("Control plane server can only be started once");
    }
    this.#started = true;
    this.#startPromise = this.#performStart();
    await this.#startPromise;
  }

  async #performStart(): Promise<void> {
    const server = createServer((socket) => this.#acceptConnection(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onStartupError);
        resolve();
      };
      const onStartupError = (error: Error): void => {
        server.off("listening", onListening);
        reject(new ControlPlaneServerError("Control plane socket could not listen", { cause: error }));
      };
      server.once("listening", onListening);
      server.once("error", onStartupError);
      server.listen(this.#options.socketPath);
    });
    this.#ownsSocket = true;
    server.on("error", (error) => this.#fail(new ControlPlaneServerError("Control plane server failed", { cause: error })));

    try {
      await chmod(this.#options.socketPath, 0o600);
    } catch (error) {
      const permissionError = new ControlPlaneServerError("Could not restrict control plane socket permissions", {
        cause: error instanceof Error ? error : undefined,
      });
      try {
        await this.#performClose();
      } catch (cleanupError) {
        throw new AggregateError([permissionError, cleanupError], "Control plane startup and cleanup failed");
      }
      throw permissionError;
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closePromise = (async () => {
      let startupError: Error | null = null;
      try {
        await this.#startPromise;
      } catch (error) {
        startupError = asError(error);
      }
      try {
        await this.#performClose();
      } catch (cleanupError) {
        if (startupError !== null) {
          throw new AggregateError([startupError, cleanupError], "Control plane startup and cleanup failed");
        }
        throw cleanupError;
      }
      if (startupError !== null) {
        throw startupError;
      }
    })();
    return this.#closePromise;
  }

  #acceptConnection(socket: Socket): void {
    socket.once("error", () => undefined);
    const capacityExceeded = this.#sockets.size >= this.#options.maxConnections;
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    if (this.#closing || capacityExceeded) {
      const code: ControlErrorCode = this.#closing ? "internal_error" : "capacity_exceeded";
      this.#writeResponse(socket, {
        requestId: null,
        ok: false,
        error: {
          code,
          message: this.#closing ? "Control plane is closing" : "Control plane connection limit exceeded",
        },
      });
      return;
    }

    socket.setNoDelay(true);
    this.#readRequest(socket);
  }

  #readRequest(socket: Socket): void {
    const chunks: Buffer[] = [];
    let lineByteLength = 0;
    let receivedByteLength = 0;
    let completed = false;
    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        socket.off("close", onClose);
        this.#writeError(socket, null, "request_timeout", "Control request was not received in time");
      }
    }, this.#options.requestTimeoutMs);

    const onClose = (): void => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("end", onEnd);
      }
    };

    const finish = (line: Buffer, trailing: Buffer): void => {
      if (completed) {
        socket.destroy();
        return;
      }
      completed = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("data", onData);
      socket.off("end", onEnd);
      if (trailing.toString("utf8").trim() !== "") {
        this.#writeError(socket, null, "invalid_request", "Control connection accepts one request");
        return;
      }
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        value = JSON.parse(text);
      } catch (error) {
        this.#writeError(socket, null, "invalid_request", "Control request is not valid UTF-8 JSON");
        return;
      }
      void this.#handleRequest(socket, value);
    };

    const onData = (chunk: Buffer): void => {
      if (completed) {
        socket.destroy();
        return;
      }
      const newlineIndex = chunk.indexOf(0x0a);
      const content = newlineIndex < 0 ? chunk : chunk.subarray(0, newlineIndex);
      receivedByteLength += chunk.length;
      lineByteLength += content.length;
      if (receivedByteLength > this.#options.maxMessageBytes) {
        completed = true;
        clearTimeout(timer);
        socket.off("close", onClose);
        socket.off("data", onData);
        socket.off("end", onEnd);
        this.#writeError(socket, null, "invalid_request", "Control request exceeds the message limit");
        return;
      }
      chunks.push(content);
      if (newlineIndex >= 0) {
        finish(Buffer.concat(chunks, lineByteLength), chunk.subarray(newlineIndex + 1));
      }
    };

    const onEnd = (): void => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        socket.off("close", onClose);
        this.#writeError(socket, null, "invalid_request", "Control request ended before a newline");
      }
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  }

  async #handleRequest(socket: Socket, value: unknown): Promise<void> {
    const envelope = controlEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      this.#writeError(socket, extractRequestId(value), "invalid_request", "Control request envelope is invalid");
      return;
    }
    if (!timingSafeEqual(this.#tokenDigest, digestToken(envelope.data.token))) {
      this.#writeError(socket, envelope.data.requestId, "authentication_failed", "Control authentication failed");
      return;
    }
    if (envelope.data.sessionId !== this.#options.sessionId) {
      this.#writeError(socket, envelope.data.requestId, "session_mismatch", "Control request targets another session");
      return;
    }
    const replayError = this.#reserveRequestId(envelope.data.requestId);
    if (replayError !== null) {
      this.#writeError(socket, envelope.data.requestId, replayError.code, replayError.message);
      return;
    }
    const parsed = controlRequestSchema.safeParse(value);
    if (!parsed.success) {
      this.#writeError(socket, envelope.data.requestId, "invalid_request", "Control request parameters are invalid");
      return;
    }

    const controller = new AbortController();
    this.#requestControllers.add(controller);
    const onSocketClose = (): void => {
      controller.abort(new ControlPlaneServerError("Control client disconnected"));
    };
    socket.once("close", onSocketClose);
    try {
      const result = await this.#enqueue(parsed.data, controller);
      this.#writeResponse(socket, {
        requestId: parsed.data.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.#writeError(socket, parsed.data.requestId, "request_timeout", "Control request timed out");
        return;
      }
      this.#writeError(socket, parsed.data.requestId, "internal_error", "Control request failed");
    } finally {
      socket.off("close", onSocketClose);
      this.#requestControllers.delete(controller);
    }
  }

  #enqueue(request: ControlRequest, controller: AbortController): Promise<unknown> {
    const execution = this.#executionQueue.then(async () => {
      if (controller.signal.aborted) {
        throw new ControlPlaneServerError("Control request was aborted before execution");
      }
      const context = { requestId: request.requestId, signal: controller.signal };
      let result: unknown;
      switch (request.method) {
        case "switch":
          result = await this.#options.handler.switchModel(request.params, context);
          break;
        case "confirm":
          result = await this.#options.handler.confirmSwitch(request.params, context);
          break;
        case "state":
          result = await this.#options.handler.getState(context);
          break;
      }
      return controlResultSchemas[request.method].parse(result);
    });
    this.#executionQueue = execution.then(() => undefined, () => undefined);

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(controller.signal.reason);
      };
      const timeout = setTimeout(() => {
        controller.abort(new ControlPlaneServerError("Control request timed out"));
      }, this.#options.requestTimeoutMs);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      execution.then(
        (result) => {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  #reserveRequestId(requestId: string): { code: ControlErrorCode; message: string } | null {
    const now = performance.now();
    for (const [id, timestamp] of this.#replayEntries) {
      if (now - timestamp < this.#options.replayTtlMs) {
        break;
      }
      this.#replayEntries.delete(id);
    }
    if (this.#replayEntries.has(requestId)) {
      return { code: "replay_detected", message: "Control request identifier was already used" };
    }
    if (this.#replayEntries.size >= this.#options.maxReplayEntries) {
      return { code: "capacity_exceeded", message: "Control replay capacity exceeded" };
    }
    this.#replayEntries.set(requestId, now);
    return null;
  }

  #writeError(socket: Socket, requestId: string | null, code: ControlErrorCode, message: string): void {
    this.#writeResponse(socket, {
      requestId,
      ok: false,
      error: { code, message },
    });
  }

  #writeResponse(socket: Socket, response: ControlResponse): void {
    if (socket.destroyed) {
      return;
    }
    socket.end(`${JSON.stringify(response)}\n`);
  }

  #fail(error: Error): void {
    if (this.#failed || this.#closing) {
      return;
    }
    this.#failed = true;
    this.#options.onFatalError?.(error);
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    for (const controller of this.#requestControllers) {
      controller.abort(new ControlPlaneServerError("Control plane server closed"));
    }
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();

    const errors: Error[] = [];
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error == null ? resolve() : reject(error));
        });
      } catch (error) {
        errors.push(asError(error));
      }
    }
    if (this.#ownsSocket) {
      try {
        await rm(this.#options.socketPath, { force: false });
      } catch (error) {
        const nodeError = asError(error) as NodeJS.ErrnoException;
        if (nodeError.code !== "ENOENT") {
          errors.push(nodeError);
        }
      }
      this.#ownsSocket = false;
    }
    if (errors.length === 1) {
      throw errors[0] ?? new ControlPlaneServerError("Control plane cleanup failed");
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Control plane cleanup failed");
    }
  }
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function extractRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("requestId" in value)) {
    return null;
  }
  const requestId = value.requestId;
  return typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)
    ? requestId
    : null;
}

function validatePositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new ControlPlaneServerError(String(error));
}
