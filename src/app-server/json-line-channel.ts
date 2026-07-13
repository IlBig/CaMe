import type { Readable, Writable } from "node:stream";

import {
  AppServerConnectionClosedError,
  AppServerProtocolError,
  type JsonRpcMessage,
  parseJsonRpcMessage,
} from "./protocol.js";

export const DEFAULT_MAX_JSON_LINE_BYTES = 16 * 1024 * 1024;

type MessageListener = (message: JsonRpcMessage) => void;
type CloseListener = (error: Error) => void;

export class JsonLineChannel {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #maxLineBytes: number;
  readonly #messageListeners = new Set<MessageListener>();
  readonly #closeListeners = new Set<CloseListener>();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #closedPromise: Promise<never>;
  #buffer = "";
  #closedError: Error | null = null;
  #rejectClosed: ((error: Error) => void) | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(input: Readable, output: Writable, maxLineBytes = DEFAULT_MAX_JSON_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }

    this.#input = input;
    this.#output = output;
    this.#maxLineBytes = maxLineBytes;
    this.#closedPromise = new Promise<never>((_resolve, reject) => {
      this.#rejectClosed = reject;
    });
    void this.#closedPromise.catch(() => undefined);
    this.#input.on("data", this.#handleData);
    this.#input.once("end", this.#handleEnd);
    this.#input.once("error", this.#handleInputError);
    this.#input.once("close", this.#handleInputClose);
    this.#output.once("error", this.#handleOutputError);
    this.#output.once("close", this.#handleOutputClose);
  }

  public onMessage(listener: MessageListener): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  public onClose(listener: CloseListener): () => void {
    if (this.#closedError !== null) {
      listener(this.#closedError);
      return () => undefined;
    }

    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public send(message: JsonRpcMessage): Promise<void> {
    if (this.#closedError !== null) {
      return Promise.reject(this.#closedError);
    }

    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(new AppServerProtocolError("JSON-RPC message is not serializable", { cause: error }));
    }
    if (Buffer.byteLength(line) > this.#maxLineBytes) {
      return Promise.reject(new AppServerProtocolError("Outgoing JSON-RPC line exceeds the configured limit"));
    }

    const write = this.#writeQueue.then(() => this.#write(line));
    this.#writeQueue = write.catch(() => undefined);
    return Promise.race([write, this.#closedPromise]);
  }

  public close(error = new AppServerConnectionClosedError()): void {
    this.#close(error);
  }

  readonly #handleData = (chunk: Buffer | string): void => {
    if (this.#closedError !== null) {
      return;
    }

    try {
      this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    } catch (error) {
      this.#close(new AppServerProtocolError("Codex App Server emitted invalid UTF-8", { cause: error }));
      return;
    }
    if (Buffer.byteLength(this.#buffer) > this.#maxLineBytes && !this.#buffer.includes("\n")) {
      this.#close(new AppServerProtocolError("Incoming JSON-RPC line exceeds the configured limit"));
      return;
    }

    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(line) > this.#maxLineBytes) {
        this.#close(new AppServerProtocolError("Incoming JSON-RPC line exceeds the configured limit"));
        return;
      }
      if (line.trim() !== "") {
        this.#parseLine(line);
        if (this.#closedError !== null) {
          return;
        }
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }

    if (Buffer.byteLength(this.#buffer) > this.#maxLineBytes) {
      this.#close(new AppServerProtocolError("Incoming JSON-RPC line exceeds the configured limit"));
    }
  };

  readonly #handleEnd = (): void => {
    try {
      this.#buffer += this.#decoder.decode();
    } catch (error) {
      this.#close(new AppServerProtocolError("Codex App Server ended with invalid UTF-8", { cause: error }));
      return;
    }
    if (this.#buffer.trim() !== "") {
      this.#close(new AppServerProtocolError("Codex App Server ended with an incomplete JSON-RPC line"));
      return;
    }
    this.#close(new AppServerConnectionClosedError());
  };

  readonly #handleInputError = (error: Error): void => {
    this.#close(new AppServerConnectionClosedError("Codex App Server input failed", { cause: error }));
  };

  readonly #handleInputClose = (): void => {
    this.#close(new AppServerConnectionClosedError("Codex App Server input closed"));
  };

  readonly #handleOutputError = (error: Error): void => {
    this.#close(new AppServerConnectionClosedError("Codex App Server output failed", { cause: error }));
  };

  readonly #handleOutputClose = (): void => {
    this.#close(new AppServerConnectionClosedError("Codex App Server output closed"));
  };

  #parseLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      const value: unknown = JSON.parse(line);
      message = parseJsonRpcMessage(value);
    } catch (error) {
      this.#close(new AppServerProtocolError("Invalid JSON-RPC line from Codex App Server", { cause: error }));
      return;
    }

    for (const listener of this.#messageListeners) {
      try {
        listener(message);
      } catch (error) {
        this.#close(new AppServerProtocolError("JSON-RPC message listener failed", { cause: error }));
        return;
      }
    }
  }

  #write(line: string): Promise<void> {
    if (this.#closedError !== null) {
      return Promise.reject(this.#closedError);
    }

    return new Promise((resolve, reject) => {
      this.#output.write(line, "utf8", (error) => {
        if (error !== null && error !== undefined) {
          const wrapped = new AppServerConnectionClosedError("Codex App Server write failed", { cause: error });
          this.#close(wrapped);
          reject(wrapped);
          return;
        }
        resolve();
      });
    });
  }

  #close(error: Error): void {
    if (this.#closedError !== null) {
      return;
    }

    this.#closedError = error;
    this.#rejectClosed?.(error);
    this.#rejectClosed = null;
    this.#input.off("data", this.#handleData);
    this.#input.off("end", this.#handleEnd);
    this.#input.off("error", this.#handleInputError);
    this.#input.off("close", this.#handleInputClose);
    this.#output.off("error", this.#handleOutputError);
    this.#output.off("close", this.#handleOutputClose);
    this.#messageListeners.clear();
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
      throw new AggregateError(listenerErrors, "JSON line channel close listeners failed");
    }
  }
}
