/**
 * kernel-error-parser.ts — Parses Python and Julia tracebacks into structured error metadata.
 *
 * Responsible for:
 * 1. Stripping ANSI escape codes (SGR, OSC 8 hyperlinks) from raw traceback text.
 * 2. Extracting file/line/column locations from Python traceback frames, Julia
 *    `In[N]:line:col` references, `@ file:line` frames, caret lines, and evalue strings.
 * 3. Ranking candidate traceback frames so that user code is preferred over
 *    internal pdv_kernel/PDVJulia frames or synthetic cell paths.
 * 4. Adjusting line numbers for leading blank lines in code-cell submissions.
 * 5. Building a single `KernelExecutionError` object with a human-readable
 *    summary that includes source context and location when available.
 *
 * This module is a pure-function utility: it has no side effects, does not
 * import Node.js APIs, and does not interact with ZeroMQ or Electron IPC.
 *
 * See Also
 * --------
 * kernel-manager.ts — calls buildExecutionError() when an iopub error arrives
 */

import type { KernelExecutionOrigin, KernelExecutionError } from "./kernel-manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Best-effort parsed location metadata extracted from traceback text. */
export interface KernelExecutionLocation {
  /** Filename/path from traceback frames when present. */
  file?: string;
  /** 1-based line number when present. */
  line?: number;
  /** 1-based column number when present (typically syntax errors). */
  column?: number;
}

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m|\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const TRACEBACK_FILE_LINE_RE = /^\s*File "([^"]+)", line (\d+)(?:, in .+)?$/;
const TRACEBACK_FILE_LINE_BARE_RE = /^\s*File ([^,]+), line (\d+)(?:, in .+)?$/;
const TRACEBACK_CELL_LINE_RE = /^\s*Cell In\[\d+\], line (\d+)(?:, in .+)?$/;
const EVALUE_FILE_LINE_RE = /\(([^,()]+), line (\d+)\)/;
// Julia: "In[10]:1:20" or "@ file.jl:42" or "@ ./file.jl:42"
const JULIA_CELL_LINE_RE = /In\[\d+\]:(\d+)(?::(\d+))?/;
const JULIA_AT_FILE_LINE_RE = /@ ([^\s:]+):(\d+)/;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TracebackFrame {
  file: string;
  line: number;
  column?: number;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_RE, "");
}

function findCaretColumn(lines: string[], startIndex: number): number | undefined {
  for (let offset = 1; offset <= 4; offset += 1) {
    const line = lines[startIndex + offset];
    if (!line) continue;
    const caretIndex = line.indexOf("^");
    if (caretIndex >= 0) {
      return caretIndex + 1;
    }
  }
  return undefined;
}

function parseTracebackFrames(traceback: string[]): TracebackFrame[] {
  const cleanLines = traceback.map(stripAnsi);
  const frames: TracebackFrame[] = [];

  for (let index = 0; index < cleanLines.length; index += 1) {
    const line = cleanLines[index];

    // Python: File "...", line N / Cell In[N], line N
    const quotedFile = TRACEBACK_FILE_LINE_RE.exec(line);
    const bareFile = TRACEBACK_FILE_LINE_BARE_RE.exec(line);
    const cellFrame = TRACEBACK_CELL_LINE_RE.exec(line);

    // Julia: In[N]:line:col or @ file.jl:line
    const juliaCell = JULIA_CELL_LINE_RE.exec(line);
    const juliaAt = JULIA_AT_FILE_LINE_RE.exec(line);

    const fileValue = quotedFile?.[1] ?? bareFile?.[1]
      ?? (cellFrame ? "<ipython-cell>" : undefined)
      ?? (juliaCell ? "<julia-cell>" : undefined)
      ?? juliaAt?.[1];
    const lineToken = quotedFile?.[2] ?? bareFile?.[2] ?? cellFrame?.[1]
      ?? juliaCell?.[1] ?? juliaAt?.[2];
    if (!fileValue || !lineToken) continue;

    const lineValue = Number.parseInt(lineToken, 10);
    if (!Number.isFinite(lineValue)) continue;

    // Julia cell frames can include column inline (In[N]:line:col)
    let column = juliaCell?.[2] ? Number.parseInt(juliaCell[2], 10) : undefined;
    if (column === undefined || !Number.isFinite(column)) {
      column = findCaretColumn(cleanLines, index);
    }

    frames.push({ file: fileValue.trim(), line: lineValue, column });
  }

  return frames;
}

function framePriority(frame: TracebackFrame): number {
  if (frame.file.includes("/pdv_kernel/") || frame.file.includes("/PDVJulia/")) return 0;
  if (frame.file.startsWith("<")) return 1;
  return 2;
}

function selectBestFrame(frames: TracebackFrame[]): TracebackFrame | undefined {
  let best: TracebackFrame | undefined;
  let bestPriority = -1;

  for (const frame of frames) {
    const priority = framePriority(frame);
    if (priority >= bestPriority) {
      best = frame;
      bestPriority = priority;
    }
  }

  return best;
}

function parseLocationFromEvalue(evalue: string): KernelExecutionLocation | undefined {
  const match = EVALUE_FILE_LINE_RE.exec(evalue);
  if (!match) return undefined;
  const line = Number.parseInt(match[2], 10);
  if (!Number.isFinite(line)) return undefined;
  return { file: match[1], line };
}

function parseFallbackLocationFromTraceback(
  traceback: string[]
): KernelExecutionLocation | undefined {
  const cleanLines = traceback.map(stripAnsi);
  let line: number | undefined;
  let column: number | undefined;

  for (const current of cleanLines) {
    const lineMatch = /\bline (\d+)\b/.exec(current);
    if (!lineMatch) continue;
    const parsed = Number.parseInt(lineMatch[1], 10);
    if (Number.isFinite(parsed)) {
      line = parsed;
      break;
    }
  }

  if (line === undefined) {
    for (const current of cleanLines) {
      const lineMatch = /---->\s*(\d+)/.exec(current);
      if (!lineMatch) continue;
      const parsed = Number.parseInt(lineMatch[1], 10);
      if (Number.isFinite(parsed)) {
        line = parsed;
        break;
      }
    }
  }

  for (const current of cleanLines) {
    const caretIndex = current.indexOf("^");
    if (caretIndex >= 0) {
      column = caretIndex + 1;
      break;
    }
  }

  if (line === undefined && column === undefined) {
    return undefined;
  }
  return { line, column };
}

function parseExecutionLocation(
  traceback: string[],
  evalue: string
): KernelExecutionLocation | undefined {
  const frame = selectBestFrame(parseTracebackFrames(traceback));
  if (frame) {
    return {
      file: frame.file,
      line: frame.line,
      column: frame.column,
    };
  }
  const evalueLocation = parseLocationFromEvalue(evalue);
  const fallbackLocation = parseFallbackLocationFromTraceback(traceback);
  if (evalueLocation || fallbackLocation) {
    return {
      ...(evalueLocation ?? {}),
      ...(fallbackLocation ?? {}),
    };
  }
  return undefined;
}

function countLeadingBlankLines(code: string): number {
  const lines = code.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (line.trim().length > 0) break;
    count += 1;
  }
  return count;
}

function adjustCellLocationForLeadingBlankLines(
  location: KernelExecutionLocation | undefined,
  source: KernelExecutionOrigin | undefined,
  code: string
): KernelExecutionLocation | undefined {
  if (!location || source?.kind !== "code-cell") return location;
  if (typeof location.line !== "number") return location;
  if (location.file && !location.file.startsWith("<")) return location;
  const leadingBlankLines = countLeadingBlankLines(code);
  if (leadingBlankLines <= 0) return location;
  return {
    ...location,
    line: location.line + leadingBlankLines,
  };
}

function formatExecutionSource(source: KernelExecutionOrigin | undefined): string | undefined {
  if (!source) return undefined;
  const label = source.label?.trim();
  if (source.kind === "code-cell") {
    return label ? `Code cell "${label}"` : "Code cell";
  }
  if (source.kind === "tree-script") {
    return label ? `Script "${label}"` : "Script";
  }
  return label ? `Execution "${label}"` : "Execution";
}

function formatExecutionLocation(
  location: KernelExecutionLocation | undefined
): string | undefined {
  if (!location) return undefined;
  const parts: string[] = [];
  if (location.file && !location.file.startsWith("<")) {
    parts.push(location.file);
  }
  if (typeof location.line === "number") {
    parts.push(`line ${location.line}`);
  }
  if (typeof location.column === "number") {
    parts.push(`column ${location.column}`);
  }
  if (parts.length === 0 && location.file) {
    parts.push(location.file);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a structured `KernelExecutionError` from raw iopub error fields.
 *
 * Parses the traceback to extract file/line/column location metadata, adjusts
 * for leading blank lines in code-cell submissions, and assembles a one-line
 * human-readable summary that includes source and location context.
 *
 * @param name - Exception class name (e.g. `ValueError`).
 * @param message - Exception message string (evalue).
 * @param traceback - Raw traceback lines (may contain ANSI escape codes).
 * @param source - Optional execution-origin metadata from the request context.
 * @param code - Optional source code string; used to adjust line numbers for
 *               leading blank lines in code-cell submissions.
 * @returns A fully populated `KernelExecutionError`.
 */
export function buildExecutionError(
  name: string,
  message: string,
  traceback: string[],
  source?: KernelExecutionOrigin,
  code?: string
): KernelExecutionError {
  const normalizedName = name || "Error";
  const normalizedMessage = message ?? "";
  const parsedLocation = parseExecutionLocation(traceback, normalizedMessage);
  const location = code
    ? adjustCellLocationForLeadingBlankLines(parsedLocation, source, code)
    : parsedLocation;
  const sourceText = formatExecutionSource(source);
  const locationText = formatExecutionLocation(location);
  const base = normalizedMessage
    ? `${normalizedName}: ${normalizedMessage}`
    : normalizedName;

  let summary = base;
  if (sourceText && locationText) {
    summary = `${sourceText} (${locationText}): ${base}`;
  } else if (sourceText) {
    summary = `${sourceText}: ${base}`;
  } else if (locationText) {
    summary = `${base} (${locationText})`;
  }

  return {
    name: normalizedName,
    message: normalizedMessage,
    summary,
    traceback,
    location,
    source,
  };
}
