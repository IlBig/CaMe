import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AppServerConnectionClosedError,
  AppServerProtocolError,
  JsonLineChannel,
} from "../../src/index.js";
import { JsonLinePeer } from "./test-peer.js";

describe("JsonLineChannel", () => {
  it("parses fragmented multibyte JSON lines", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = new JsonLineChannel(input, output);
    const received = new Promise<unknown>((resolve) => channel.onMessage(resolve));
    const encoded = Buffer.from(`${JSON.stringify({ method: "evento/è", params: { value: "€" } })}\n`);
    const euroIndex = encoded.indexOf(Buffer.from("€"));

    input.write(encoded.subarray(0, euroIndex + 1));
    input.write(encoded.subarray(euroIndex + 1));

    await expect(received).resolves.toEqual({ method: "evento/è", params: { value: "€" } });
    channel.close();
  });

  it("serializes writes in call order", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonLinePeer(output);
    const channel = new JsonLineChannel(input, output);

    await Promise.all([
      channel.send({ method: "first" }),
      channel.send({ method: "second" }),
    ]);

    await expect(peer.next()).resolves.toMatchObject({ method: "first" });
    await expect(peer.next()).resolves.toMatchObject({ method: "second" });
    channel.close();
  });

  it("closes on invalid JSON, invalid UTF-8 and incomplete EOF", async () => {
    const cases = [
      Buffer.from("{invalid}\n"),
      Buffer.from([0xff, 0x0a]),
      Buffer.from("{\"method\":\"partial\"}"),
    ];

    for (const [index, bytes] of cases.entries()) {
      const input = new PassThrough();
      const output = new PassThrough();
      const channel = new JsonLineChannel(input, output);
      const closed = new Promise<Error>((resolve) => channel.onClose(resolve));
      input.write(bytes);
      if (index === 2) {
        input.end();
      }
      await expect(closed).resolves.toBeInstanceOf(AppServerProtocolError);
    }
  });

  it("detects an oversized residual after a valid line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = new JsonLineChannel(input, output, 64);
    const closed = new Promise<Error>((resolve) => channel.onClose(resolve));

    input.write(`${JSON.stringify({ method: "ok" })}\n${"x".repeat(65)}`);

    await expect(closed).resolves.toBeInstanceOf(AppServerProtocolError);
  });

  it("rejects non-serializable and oversized outbound messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = new JsonLineChannel(input, output, 64);

    await expect(channel.send({ method: "bigint", params: 1n })).rejects.toBeInstanceOf(AppServerProtocolError);
    await expect(channel.send({ method: "oversized", params: "x".repeat(64) })).rejects.toBeInstanceOf(AppServerProtocolError);
    channel.close();
  });

  it("rejects a blocked write when the channel closes", async () => {
    const state: { writeCallback: ((error?: Error | null) => void) | null } = { writeCallback: null };
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        state.writeCallback = callback;
      },
    });
    const channel = new JsonLineChannel(input, output);
    const send = channel.send({ method: "blocked" });

    channel.close(new AppServerConnectionClosedError("closed by test"));

    await expect(send).rejects.toThrow("closed by test");
    state.writeCallback?.();
  });
});
