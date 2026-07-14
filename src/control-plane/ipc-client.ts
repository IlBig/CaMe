import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

import {
  CONTROL_PROTOCOL_VERSION,
  DEFAULT_CONTROL_MAX_MESSAGE_BYTES,
  DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
  controlAuthTokenSchema,
  controlResponseSchema,
  controlResultSchemas,
  type ControlErrorCode,
  type ControlMethod,
} from "./protocol.js";
import type {
  ConfirmSwitchRequest,
  SessionState,
  SwitchRequest,
  SwitchResult,
} from "../contracts.js";

export type ControlPlaneClientOptions = {
  socketPath: string;
  sessionId: string;
  authToken: string;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
};

export class ControlPlaneClientError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ControlPlaneClientError";
  }
}

export class ControlPlaneRemoteError extends Error {
  public readonly code: ControlErrorCode;

  public constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneRemoteError";
    this.code = code;
  }
}

export class ControlPlaneClient {
  readonly #options: Required<ControlPlaneClientOptions>;

  public constructor(options: ControlPlaneClientOptions) {
    if (!isAbsolute(options.socketPath)) {
      throw new RangeError("Control socket path must be absolute");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(options.sessionId)) {
      throw new RangeError("Control session identifier must be a UUID");
    }
    controlAuthTokenSchema.parse(options.authToken);
    validatePositiveInteger(options.requestTimeoutMs, "Control client timeout");
    validatePositiveInteger(options.maxMessageBytes, "Control client message limit");
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_CONTROL_MAX_MESSAGE_BYTES,
    };
  }

  public switchModel(request: SwitchRequest, signal?: AbortSignal): Promise<SwitchResult> {
    return this.#call("switch", request, signal);
  }

  public confirmSwitch(request: ConfirmSwitchRequest, signal?: AbortSignal): Promise<SwitchResult> {
    return this.#call("confirm", request, signal);
  }

  public getState(signal?: AbortSignal): Promise<SessionState> {
    return this.#call("state", {}, signal);
  }

  #call<T extends ControlMethod>(method: T, params: unknown, signal?: AbortSignal): Promise<ReturnType<(typeof controlResultSchemas)[T]["parse"]>> {
    const requestId = randomUUID();
    const request = {
      version: CONTROL_PROTOCOL_VERSION,
      requestId,
      sessionId: this.#options.sessionId,
      token: this.#options.authToken,
      method,
      params,
    };
    let requestLine: string;
    try {
      requestLine = `${JSON.stringify(request)}\n`;
    } catch (error) {
      return Promise.reject(new ControlPlaneClientError("Control request is not serializable", {
        cause: error instanceof Error ? error : undefined,
      }));
    }
    if (Buffer.byteLength(requestLine) > this.#options.maxMessageBytes) {
      return Promise.reject(new ControlPlaneClientError("Control request exceeds the message limit"));
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#options.socketPath);
      const chunks: Buffer[] = [];
      let lineByteLength = 0;
      let receivedByteLength = 0;
      let settled = false;
      const settle = (error?: Error, result?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(result as ReturnType<(typeof controlResultSchemas)[T]["parse"]>);
      };
      const onAbort = (): void => settle(new ControlPlaneClientError("Control request was aborted", {
        cause: signal?.reason instanceof Error ? signal.reason : undefined,
      }));
      const timeout = setTimeout(() => settle(new ControlPlaneClientError("Control request timed out")), this.#options.requestTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }

      socket.once("connect", () => {
        socket.setNoDelay(true);
        socket.write(requestLine);
      });
      socket.on("data", (chunk: Buffer) => {
        const newlineIndex = chunk.indexOf(0x0a);
        const content = newlineIndex < 0 ? chunk : chunk.subarray(0, newlineIndex);
        receivedByteLength += chunk.length;
        lineByteLength += content.length;
        if (receivedByteLength > this.#options.maxMessageBytes) {
          settle(new ControlPlaneClientError("Control response exceeds the message limit"));
          return;
        }
        chunks.push(content);
        if (newlineIndex < 0) {
          return;
        }
        if (chunk.subarray(newlineIndex + 1).toString("utf8").trim() !== "") {
          settle(new ControlPlaneClientError("Control server returned multiple responses"));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, lineByteLength)));
        } catch (error) {
          settle(new ControlPlaneClientError("Control server returned invalid UTF-8 JSON", {
            cause: error instanceof Error ? error : undefined,
          }));
          return;
        }
        const response = controlResponseSchema.safeParse(value);
        if (!response.success || response.data.requestId !== requestId) {
          settle(new ControlPlaneClientError("Control server returned an invalid response envelope"));
          return;
        }
        if (!response.data.ok) {
          settle(new ControlPlaneRemoteError(response.data.error.code, response.data.error.message));
          return;
        }
        try {
          settle(undefined, controlResultSchemas[method].parse(response.data.result));
        } catch (error) {
          settle(new ControlPlaneClientError("Control server returned an invalid result", {
            cause: error instanceof Error ? error : undefined,
          }));
        }
      });
      socket.once("end", () => {
        if (!settled) {
          settle(new ControlPlaneClientError("Control server ended without a response"));
        }
      });
      socket.once("error", (error) => settle(new ControlPlaneClientError("Control socket failed", { cause: error })));
      socket.once("close", () => {
        if (!settled) {
          settle(new ControlPlaneClientError("Control socket closed without a response"));
        }
      });
    });
  }
}

function validatePositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
