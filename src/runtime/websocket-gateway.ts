import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { AppServerBridge } from "../app-server/app-server-bridge.js";
import type { JsonRpcMessage } from "../app-server/protocol.js";

export const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

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
  readonly #connectionWaiters = new Set<ConnectionWaiter>();
  #server: WebSocketServer | null = null;
  #client: WebSocket | null = null;
  #bridgeUnsubscribe: (() => void) | null = null;
  #receiveQueue: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;
  #started = false;
  #closing = false;
  #failed = false;

  public constructor(bridge: AppServerBridge, authToken: string, fatalListener: (error: Error) => void) {
    if (authToken.length < 32) {
      throw new RangeError("Gateway authentication token must contain at least 32 characters");
    }
    this.#bridge = bridge;
    this.#authToken = authToken;
    this.#fatalListener = fatalListener;
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
    await this.#bridge.forwardClientMessage(value);
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
