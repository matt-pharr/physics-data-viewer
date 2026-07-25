/**
 * line-codec.test.ts — Framing tests for the RPC transport's line codec.
 *
 * Covers the reassembly and robustness properties the transport depends
 * on: arbitrary chunk boundaries, several lines per chunk, unparseable
 * lines skipped without derailing the stream, the max-line guard
 * discarding and resynchronizing, and the writer's serialized queue
 * honoring backpressure from a slow reader.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LineDecoder, LineWriter, encodeMessage } from "./line-codec";

describe("encodeMessage", () => {
  it("frames a message as one newline-terminated JSON line", () => {
    const buf = encodeMessage({ a: 1 });
    expect(buf.toString("utf8")).toBe('{"a":1}\n');
  });
});

describe("LineDecoder", () => {
  let messages: unknown[];
  let decoder: LineDecoder;

  beforeEach(() => {
    messages = [];
    decoder = new LineDecoder({ onMessage: (m) => messages.push(m) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reassembles a line split across many partial chunks", () => {
    const frame = encodeMessage({ id: "1", channel: "tree:list", args: [] });
    for (let i = 0; i < frame.length; i += 3) {
      decoder.write(frame.subarray(i, i + 3));
    }
    expect(messages).toEqual([{ id: "1", channel: "tree:list", args: [] }]);
  });

  it("emits every line when several arrive in one chunk", () => {
    const chunk = Buffer.concat([
      encodeMessage({ n: 1 }),
      encodeMessage({ n: 2 }),
      encodeMessage({ n: 3 }),
    ]);
    decoder.write(chunk);
    expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("skips empty lines and tolerates \\r\\n termination", () => {
    decoder.write(Buffer.from('\n\n{"ok":true}\r\n\n', "utf8"));
    expect(messages).toEqual([{ ok: true }]);
  });

  it("logs and skips an unparseable line, then keeps decoding", () => {
    decoder.write(Buffer.from('not json at all\n{"n":1}\n', "utf8"));
    expect(messages).toEqual([{ n: 1 }]);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("discards an oversized line and resynchronizes at the next newline", () => {
    const small = new LineDecoder({
      onMessage: (m) => messages.push(m),
      maxLineBytes: 32,
    });
    const oversized = Buffer.from(`{"blob":"${"x".repeat(100)}"}`, "utf8");
    // Stream the oversized line in pieces, then a newline, then a good line.
    small.write(oversized.subarray(0, 50));
    small.write(oversized.subarray(50));
    small.write(Buffer.from("\n", "utf8"));
    small.write(encodeMessage({ after: true }));
    expect(messages).toEqual([{ after: true }]);
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe("LineWriter", () => {
  it("delivers all messages in order through a backpressured stream", async () => {
    // Tiny highWaterMark: with no reader attached, the first few writes
    // fill the buffer and write() returns false, forcing the pump to wait
    // for drain. Attaching the reader afterwards drains everything.
    const stream = new PassThrough({ highWaterMark: 64 });
    const writer = new LineWriter(stream);
    const count = 200;
    for (let i = 0; i < count; i++) {
      writer.write({ n: i, pad: "p".repeat(100) });
    }

    const received: unknown[] = [];
    const decoder = new LineDecoder({ onMessage: (m) => received.push(m) });
    stream.on("data", (chunk: Buffer) => decoder.write(chunk));

    await writer.flush();
    // Let the final data events deliver.
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(count);
    expect(received.map((m) => (m as { n: number }).n)).toEqual(
      Array.from({ length: count }, (_, i) => i)
    );
  });

  it("goes inert instead of throwing once the stream is destroyed", async () => {
    const stream = new PassThrough();
    const writer = new LineWriter(stream);
    stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => writer.write({ dropped: true })).not.toThrow();
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});
