import type { Readable, Writable } from "node:stream";

type Waiter = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class JsonLinePeer {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #queue: Record<string, unknown>[] = [];
  readonly #waiters: Waiter[] = [];
  #buffer = "";
  #closedError: Error | null = null;

  public constructor(readable: Readable) {
    readable.on("data", (chunk: Buffer | string) => {
      this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
      this.#drain();
    });
    readable.once("error", (error) => this.#close(error));
    readable.once("end", () => this.#close(new Error("Peer stream ended")));
  }

  public next(): Promise<Record<string, unknown>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.#closedError !== null) {
      return Promise.reject(this.#closedError);
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  public static write(writable: Writable, value: unknown): void {
    writable.write(`${JSON.stringify(value)}\n`);
  }

  #drain(): void {
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Expected a JSON object");
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#queue.push(value as Record<string, unknown>);
      } else {
        waiter.resolve(value as Record<string, unknown>);
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #close(error: Error): void {
    this.#closedError = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}
