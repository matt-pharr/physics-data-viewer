/**
 * transcript.ts — Session execution transcript writer (ARCHITECTURE.md §15.7).
 *
 * Appends one greppable plain-text block per kernel execution (user- and
 * agent-initiated alike) to `<workingDir>/execution-transcript.txt`. The
 * transcript is session-scoped scratch — it lives in the kernel working
 * directory next to `code-cells.json`, is never copied into the project
 * save directory, is not loaded with a project, and is discarded when the
 * working directory is torn down on shutdown.
 *
 * Why plain text rather than JSON-lines?
 * The primary consumer is an MCP agent running `grep` / `head` / `tail`
 * over the file. JSON escaping of multi-line output would break that
 * line-oriented workflow (§15.7).
 *
 * Block format:
 *
 *     ═══ exec <id> · <iso> · <origin> · <status> · <duration>s ═══
 *     --- code ---
 *     <code>
 *     --- output ---
 *     <output verbatim>
 *
 * `grep '^═══ exec'` returns a full execution index;
 * `grep ' · agent:'` filters to agent-initiated runs.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.7 — Execution output and the transcript
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  ExecuteOutputChunk,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelExecutionOrigin,
} from "../kernel-manager";

/** File name for the session transcript inside the kernel working directory. */
export const TRANSCRIPT_FILENAME = "execution-transcript.txt";

/** One execution's data, as fed to {@link TranscriptWriter.recordExecution}. */
export interface TranscriptEntry {
  /** Caller-supplied execution id (correlates with `KernelExecuteRequest.executionId`). */
  executionId: string;
  /** Origin metadata (user code cell, user script, or an MCP-agent run). */
  origin: KernelExecutionOrigin | undefined;
  /** The source code that ran, verbatim. */
  code: string;
  /** The execution's output, verbatim. */
  output: string;
  /** Execution outcome. */
  status: "ok" | "error";
  /** Wall-clock duration in seconds (e.g. `0.42`). */
  durationSeconds: number;
  /** Optional override for the header timestamp; defaults to `new Date()`. */
  timestamp?: Date;
}

/**
 * Append-only writer for the session execution transcript.
 *
 * One instance per kernel session — its `path` is exposed in run results and
 * in `project_info` so agents can `grep` it directly.
 */
export class TranscriptWriter {
  /** Absolute path to the transcript file. */
  readonly path: string;

  /**
   * Construct a writer rooted at the kernel working directory.
   *
   * @param workingDir - Absolute path to the kernel's working directory.
   */
  constructor(workingDir: string) {
    this.path = path.join(workingDir, TRANSCRIPT_FILENAME);
  }

  /**
   * Append one execution block to the transcript.
   *
   * I/O errors are caught and logged — transcript failure must never break
   * the user's execution flow. The header is constructed even if `entry` is
   * partially populated so the block remains greppable.
   *
   * @param entry - All data for the block to record.
   * @returns Resolves once the block is on disk (or the error is logged).
   */
  async recordExecution(entry: TranscriptEntry): Promise<void> {
    const block = formatBlock(entry);
    try {
      await fs.appendFile(this.path, block, "utf8");
    } catch (err) {
      console.error("[mcp] transcript append failed:", err);
    }
  }
}

/**
 * Format one execution as a single transcript block (header + code + output).
 *
 * Exported for testing — production code goes through
 * {@link TranscriptWriter.recordExecution}.
 *
 * @param entry - The execution data.
 * @returns The block as a string, including its trailing blank-line
 *   separator from the next block.
 */
export function formatBlock(entry: TranscriptEntry): string {
  const timestamp = (entry.timestamp ?? new Date()).toISOString().slice(0, 19);
  const origin = formatOrigin(entry.origin);
  const duration = entry.durationSeconds.toFixed(2);
  const header =
    `═══ exec ${entry.executionId} · ${timestamp} · ${origin} · ` +
    `${entry.status} · ${duration}s ═══`;
  // Output is verbatim; we guarantee one trailing newline before the blank
  // separator so `grep '^═══'` always finds the next header on its own line.
  const output = entry.output.endsWith("\n") ? entry.output : `${entry.output}\n`;
  return `${header}\n--- code ---\n${entry.code}\n--- output ---\n${output}\n`;
}

/**
 * Function shape of `KernelManager.execute` — narrowed so the wrapper does
 * not need to import the full manager (and so tests can stub it cheaply).
 */
export type KernelExecuteFn = (
  kernelId: string,
  request: KernelExecuteRequest,
  onChunk?: (chunk: ExecuteOutputChunk) => void,
) => Promise<KernelExecuteResult>;

/**
 * Execute on the kernel and record the run to the session transcript
 * (ARCHITECTURE.md §15.7). Designed as a wrapper around the bare
 * `KernelManager.execute` so every user- and agent-initiated call site can
 * adopt it with a one-line change. The silent kernel bootstrap exec at
 * `kernel-session.ts` is the one intentional exception — it does not flow
 * through this wrapper.
 *
 * The wrapper is fail-safe: a transcript I/O error never blocks the user's
 * execution result from returning.
 *
 * @param execute - Bound `kernelManager.execute` (or a stub in tests).
 * @param transcript - The session writer, or `null` to skip recording
 *   (e.g. before the working dir is established).
 * @param kernelId - The kernel to run on.
 * @param request - The execute request (forwarded verbatim).
 * @param onChunk - Optional streaming-output listener (forwarded verbatim).
 * @returns The kernel's execute result.
 */
export async function executeAndTranscribe(
  execute: KernelExecuteFn,
  transcript: TranscriptWriter | null,
  kernelId: string,
  request: KernelExecuteRequest,
  onChunk?: (chunk: ExecuteOutputChunk) => void,
): Promise<KernelExecuteResult> {
  const start = Date.now();
  // kernelManager.execute deletes `result.stdout`/`stderr`/`images` whenever
  // an `onChunk` is supplied (defensive against renderer double-render — see
  // kernel-manager.ts:752-761). The transcript and the MCP-tool structured
  // summary both need the accumulated text, so we accumulate it ourselves
  // here and patch it back onto the result before returning. The renderer
  // is unaffected because its handler reads `l.stdout ?? result.stdout` —
  // when streaming, `l.stdout` is already populated and shadows ours.
  let accumulatedStdout = "";
  let accumulatedStderr = "";
  const composedOnChunk: ((chunk: ExecuteOutputChunk) => void) | undefined =
    onChunk
      ? (chunk) => {
          if (chunk.type === "stdout" && chunk.text) {
            accumulatedStdout += chunk.text;
          } else if (chunk.type === "stderr" && chunk.text) {
            accumulatedStderr += chunk.text;
          }
          onChunk(chunk);
        }
      : undefined;
  const result = await execute(kernelId, request, composedOnChunk);
  if (composedOnChunk) {
    if (result.stdout === undefined && accumulatedStdout) {
      result.stdout = accumulatedStdout;
    }
    if (result.stderr === undefined && accumulatedStderr) {
      result.stderr = accumulatedStderr;
    }
  }
  if (transcript) {
    const durationSeconds =
      typeof result.duration === "number"
        ? result.duration / 1000
        : (Date.now() - start) / 1000;
    await transcript.recordExecution({
      executionId: shortenExecutionId(request.executionId),
      origin: request.origin,
      code: request.code,
      output: buildTranscriptOutput(result),
      status: result.error ? "error" : "ok",
      durationSeconds,
    });
  }
  return result;
}

/** Build the verbatim output payload (stdout, stderr, traceback) for one run. */
function buildTranscriptOutput(result: KernelExecuteResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  if (result.error) {
    if (result.errorDetails?.traceback?.length) {
      parts.push(result.errorDetails.traceback.join("\n"));
    } else {
      parts.push(result.error);
    }
  }
  return parts.join("");
}

/**
 * Short, header-friendly id for the transcript. Caller-supplied ids
 * (typically full UUIDs) are truncated; absent ids get 8 random hex chars.
 * 32 bits of entropy is more than enough for a session-scoped log.
 */
function shortenExecutionId(id: string | undefined): string {
  if (typeof id === "string" && id.length > 0) {
    return id.replace(/-/g, "").slice(0, 8);
  }
  return randomBytes(4).toString("hex");
}

/**
 * Format a {@link KernelExecutionOrigin} as the transcript header's origin field.
 *
 * Examples (matching ARCHITECTURE.md §15.7):
 * - `user:cell-2` — a code-cell run from tab 2
 * - `user:script:scripts.fit` — a user-triggered tree script
 * - `agent:pdv_run` — an MCP `pdv_run` tool call
 * - `agent:script_run:scripts.fit` — an MCP `script_run` tool call
 * - `user:unknown` — unattributed execution (e.g. legacy code paths)
 *
 * @param origin - The execution origin, or undefined for legacy callers.
 * @returns The origin string for the header line.
 */
export function formatOrigin(origin: KernelExecutionOrigin | undefined): string {
  if (!origin) return "user:unknown";
  switch (origin.kind) {
    case "code-cell":
      return typeof origin.tabId === "number"
        ? `user:cell-${origin.tabId}`
        : "user:cell";
    case "tree-script":
      return origin.scriptPath
        ? `user:script:${origin.scriptPath}`
        : "user:script";
    case "agent": {
      const tool = origin.agentTool;
      if (tool && origin.scriptPath) return `agent:${tool}:${origin.scriptPath}`;
      if (tool) return `agent:${tool}`;
      return "agent";
    }
    case "unknown":
      return "user:unknown";
  }
}
