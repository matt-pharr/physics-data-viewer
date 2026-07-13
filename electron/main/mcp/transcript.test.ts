/**
 * transcript.test.ts — Coverage for the §15.7 execution transcript writer.
 *
 * Verifies the greppability invariants the agent UX depends on (`grep '^═══'`
 * indexes every execution, `grep ' · agent:'` filters to agent runs), the
 * origin-string mapping, and that I/O failures don't propagate.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExecuteOutputChunk,
  KernelExecuteRequest,
  KernelExecuteResult,
} from "../kernel-manager";
import {
  executeAndTranscribe,
  formatBlock,
  formatOrigin,
  TRANSCRIPT_FILENAME,
  TranscriptWriter,
} from "./transcript";

const FIXED_TIMESTAMP = new Date("2026-05-18T14:32:09Z");

describe("formatOrigin", () => {
  it("formats a code-cell origin with the tab id", () => {
    expect(formatOrigin({ kind: "code-cell", tabId: 2 })).toBe("user:cell-2");
  });

  it("falls back to `user:cell` when no tab id is present", () => {
    expect(formatOrigin({ kind: "code-cell" })).toBe("user:cell");
  });

  it("formats a tree-script origin with the script path", () => {
    expect(formatOrigin({ kind: "tree-script", scriptPath: "scripts.fit" })).toBe(
      "user:script:scripts.fit",
    );
  });

  it("formats an agent origin with just the tool name", () => {
    expect(formatOrigin({ kind: "agent", agentTool: "pdv_run" })).toBe(
      "agent:pdv_run",
    );
  });

  it("formats an agent origin with tool + script path", () => {
    expect(
      formatOrigin({
        kind: "agent",
        agentTool: "script_run",
        scriptPath: "scripts.fit",
      }),
    ).toBe("agent:script_run:scripts.fit");
  });

  it("defaults to `user:unknown` for undefined / unknown origins", () => {
    expect(formatOrigin(undefined)).toBe("user:unknown");
    expect(formatOrigin({ kind: "unknown" })).toBe("user:unknown");
  });
});

describe("formatBlock", () => {
  const baseEntry = {
    executionId: "7f3b1a2c",
    code: "1/0",
    output:
      "Traceback (most recent call last):\n  ...\nZeroDivisionError: division by zero\n",
    status: "error" as const,
    durationSeconds: 0.02,
    timestamp: FIXED_TIMESTAMP,
  };

  it("emits a greppable header line starting with `═══ exec`", () => {
    const block = formatBlock({
      ...baseEntry,
      origin: { kind: "code-cell", tabId: 2 },
    });
    const lines = block.split("\n");
    expect(lines[0]).toMatch(/^═══ exec 7f3b1a2c /);
    // `grep '^═══ exec'` must find exactly one match per block.
    const headerHits = lines.filter((l) => l.startsWith("═══ exec"));
    expect(headerHits).toHaveLength(1);
  });

  it("includes origin, status, and duration in the header in order", () => {
    const block = formatBlock({
      ...baseEntry,
      origin: { kind: "agent", agentTool: "pdv_run" },
    });
    const header = block.split("\n", 1)[0];
    expect(header).toContain(" · 2026-05-18T14:32:09 · ");
    expect(header).toContain(" · agent:pdv_run · ");
    expect(header).toContain(" · error · ");
    expect(header).toMatch(/· 0\.02s ═══$/);
  });

  it("separates `--- code ---` and `--- output ---` blocks", () => {
    const block = formatBlock({
      ...baseEntry,
      origin: { kind: "code-cell", tabId: 2 },
    });
    expect(block).toContain("\n--- code ---\n1/0\n--- output ---\n");
    expect(block).toContain("ZeroDivisionError: division by zero\n");
  });

  it("normalizes output to end with a single newline before the separator", () => {
    const block = formatBlock({
      ...baseEntry,
      output: "no trailing newline",
      origin: { kind: "code-cell", tabId: 2 },
    });
    // The line after the output is blank, then the next block's header would
    // start fresh — so the verbatim output is followed by `\n\n`.
    expect(block.endsWith("no trailing newline\n\n")).toBe(true);
  });

  it("filters cleanly: `grep ' · agent:'` matches only agent blocks", () => {
    const userBlock = formatBlock({
      ...baseEntry,
      origin: { kind: "code-cell", tabId: 2 },
    });
    const agentBlock = formatBlock({
      ...baseEntry,
      origin: { kind: "agent", agentTool: "pdv_run" },
    });
    const combined = userBlock + agentBlock;
    const matched = combined
      .split("\n")
      .filter((line) => line.includes(" · agent:"));
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatch(/agent:pdv_run/);
  });
});

describe("TranscriptWriter", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-transcript-test-"));
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it("writes blocks to `<workingDir>/execution-transcript.txt`", async () => {
    const writer = new TranscriptWriter(workingDir);
    expect(writer.path).toBe(path.join(workingDir, TRANSCRIPT_FILENAME));

    await writer.recordExecution({
      executionId: "abc12345",
      origin: { kind: "code-cell", tabId: 1 },
      code: "x = 1",
      output: "",
      status: "ok",
      durationSeconds: 0.01,
      timestamp: FIXED_TIMESTAMP,
    });

    const contents = await fs.readFile(writer.path, "utf8");
    expect(contents).toMatch(/^═══ exec abc12345 /);
    expect(contents).toContain("user:cell-1");
  });

  it("appends successive blocks (preserves earlier entries)", async () => {
    const writer = new TranscriptWriter(workingDir);
    const make = (id: string, tool: string) => ({
      executionId: id,
      origin: { kind: "agent" as const, agentTool: tool },
      code: `print('${id}')`,
      output: `${id}\n`,
      status: "ok" as const,
      durationSeconds: 0.01,
      timestamp: FIXED_TIMESTAMP,
    });

    await writer.recordExecution(make("11111111", "pdv_run"));
    await writer.recordExecution(make("22222222", "script_run"));

    const contents = await fs.readFile(writer.path, "utf8");
    const headers = contents
      .split("\n")
      .filter((line) => line.startsWith("═══ exec"));
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain("11111111");
    expect(headers[1]).toContain("22222222");
  });

  it("swallows I/O errors so a failed append never breaks execution", async () => {
    // Point the writer at a path inside a non-existent parent directory.
    const writer = new TranscriptWriter(path.join(workingDir, "missing-subdir"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      writer.recordExecution({
        executionId: "deadbeef",
        origin: { kind: "code-cell", tabId: 1 },
        code: "x = 1",
        output: "",
        status: "ok",
        durationSeconds: 0.01,
        timestamp: FIXED_TIMESTAMP,
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[mcp] transcript append failed:",
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe("executeAndTranscribe", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-eat-test-"));
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  /**
   * Build a stub execute() that streams the supplied chunks and resolves
   * with the given result. Mirrors KernelManager.execute's contract that
   * deletes `stdout`/`stderr` from the result when an `onChunk` is given
   * (kernel-manager.ts:757-759).
   */
  function makeStubExecute(opts: {
    chunks: ExecuteOutputChunk[];
    result: KernelExecuteResult;
  }): (
    kernelId: string,
    request: KernelExecuteRequest,
    onChunk?: (chunk: ExecuteOutputChunk) => void,
  ) => Promise<KernelExecuteResult> {
    return async (_kernelId, _request, onChunk) => {
      for (const chunk of opts.chunks) onChunk?.(chunk);
      const result = { ...opts.result };
      if (onChunk) {
        // Mirror kernel-manager: when streaming, stdout/stderr are deleted.
        delete result.stdout;
        delete result.stderr;
      }
      return result;
    };
  }

  it("restores stdout from streamed chunks so the transcript records output", async () => {
    const writer = new TranscriptWriter(workingDir);
    const stubExecute = makeStubExecute({
      chunks: [
        { executionId: "abc", type: "stdout", text: "hello\n" },
        { executionId: "abc", type: "stdout", text: "world\n" },
      ],
      result: { duration: 10 },
    });

    // Tool-shape onChunk: forwards to the renderer (we just observe it here).
    const forwarded: ExecuteOutputChunk[] = [];
    const result = await executeAndTranscribe(
      stubExecute,
      writer,
      "k1",
      {
        code: "print('hello'); print('world')",
        executionId: "abc",
        origin: { kind: "agent", agentTool: "pdv_run" },
      },
      (chunk) => forwarded.push(chunk),
    );

    // The MCP tool's structured summary needs result.stdout populated.
    expect(result.stdout).toBe("hello\nworld\n");
    // The renderer forwarder still saw every chunk live.
    expect(forwarded).toHaveLength(2);
    // The transcript block carries the verbatim output.
    const contents = await fs.readFile(writer.path, "utf8");
    expect(contents).toContain("--- output ---\nhello\nworld\n");
    expect(contents).toContain("agent:pdv_run");
  });

  it("handles a no-onChunk run (no streaming) by reading result.stdout directly", async () => {
    const writer = new TranscriptWriter(workingDir);
    const stubExecute = makeStubExecute({
      chunks: [], // not consumed when onChunk is undefined
      result: { stdout: "direct\n", duration: 5 },
    });

    const result = await executeAndTranscribe(
      stubExecute,
      writer,
      "k1",
      {
        code: "print('direct')",
        executionId: "def",
        origin: { kind: "code-cell", tabId: 1 },
      },
      // no onChunk
    );

    expect(result.stdout).toBe("direct\n");
    const contents = await fs.readFile(writer.path, "utf8");
    expect(contents).toContain("--- output ---\ndirect\n");
  });

  it("forwards stderr accumulation alongside stdout", async () => {
    const writer = new TranscriptWriter(workingDir);
    const stubExecute = makeStubExecute({
      chunks: [
        { executionId: "x", type: "stdout", text: "ok\n" },
        { executionId: "x", type: "stderr", text: "warn\n" },
      ],
      result: { duration: 2 },
    });

    const result = await executeAndTranscribe(
      stubExecute,
      writer,
      "k1",
      {
        code: "print('ok'); print('warn', file=sys.stderr)",
        executionId: "x",
        origin: { kind: "agent", agentTool: "pdv_run" },
      },
      () => undefined,
    );

    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("warn\n");
  });
});
