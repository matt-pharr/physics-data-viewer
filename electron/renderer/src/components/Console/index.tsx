/**
 * Console panel for execution history and streamed output rendering.
 *
 * Displays code, stdout/stderr, rich display images, and execution metadata
 * emitted from kernel executions coordinated by `App`.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { LogEntry } from '../../types';
import { ansiToHtml } from './ansi';

/** Props for the execution console panel. */
interface ConsoleProps {
  logs: LogEntry[];
  onClear: () => void;
  /**
   * Run `pdv.install("<name>")` for a missing module. Provided only for uv
   * projects (§10.5.12); when omitted, the reactive install affordance is
   * hidden.
   */
  onInstallPackage?: (moduleName: string) => void;
}

/**
 * Extract the missing package from a failed-import error, or null.
 *
 * Detects Python's `ModuleNotFoundError` ("No module named 'x'") and Julia's
 * `ArgumentError` ("Package X not found in current path"). The returned
 * `installer` label matches the invocation the main process will build for
 * the active kernel language (§10.5.12).
 *
 * @param log - The console log entry.
 * @returns The missing top-level module name and installer label, or null.
 */
function missingModuleName(log: LogEntry): { name: string; installer: string } | null {
  const message = log.errorDetails?.message ?? '';
  if (log.errorDetails?.name === 'ModuleNotFoundError') {
    const match = /No module named ['"]([\w.]+)['"]/.exec(message);
    return match ? { name: match[1].split('.')[0], installer: 'pdv.install' } : null;
  }
  // Julia: `ArgumentError: Package Foo not found in current path.` — often
  // surfaced wrapped (`LoadError: ArgumentError: …`), so match the message
  // pattern rather than the error name.
  const juliaMatch = /ArgumentError: Package\s+([A-Za-z_][\w]*)\s+not found in current path/.exec(message);
  if (juliaMatch) {
    return { name: juliaMatch[1], installer: 'PDVKernel.install' };
  }
  return null;
}

/** Pixels of slack at the bottom that still count as "pinned". Larger
 *  than 0 to absorb sub-pixel rounding from zoom and HiDPI displays;
 *  small enough that scrolling up by a single line disengages. */
const PIN_THRESHOLD_PX = 4;

/** Execution console component. */
export const Console: React.FC<ConsoleProps> = ({ logs, onClear, onInstallPackage }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  // True when the viewport is at (or within PIN_THRESHOLD_PX of) the
  // bottom. Initialized true so the first batch of output scrolls into
  // view; updated on every user scroll. Stored in a ref because it's
  // read inside a layout effect and shouldn't trigger re-render.
  const pinnedToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distance <= PIN_THRESHOLD_PX;
  }, []);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // When everything fits (no scrollbar), there's no "scrolled up"
    // state to preserve — re-arm the pin so the next overflow scrolls.
    if (el.scrollHeight <= el.clientHeight + PIN_THRESHOLD_PX) {
      pinnedToBottomRef.current = true;
    }
    if (pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  return (
    <section className="console-pane">
      <header className="pane-header">
        <h2>Console</h2>
        <div className="pane-actions">
          <button className="btn btn-secondary" onClick={onClear}>
            Clear
          </button>
        </div>
      </header>

      <div className="console-content" ref={contentRef} onScroll={handleScroll}>
        {logs.length === 0 ? (
          <div className="console-empty">
            <p>No output yet</p>
            <p className="hint">Execution results will appear here</p>
          </div>
        ) : (
          logs.map((log, index) => (
            <LogEntryView
              key={log.id}
              log={log}
              index={index + 1}
              onInstallPackage={onInstallPackage}
            />
          ))
        )}
      </div>
    </section>
  );
};

/**
 * Render one console history item with optional streams/result/images.
 *
 * Memoized: streamed output replaces only the affected LogEntry object, so
 * every other entry keeps its identity and skips re-rendering. The ANSI→HTML
 * conversions are additionally memoized per source string so the entry that
 * did change re-parses only the stream that grew.
 */
const LogEntryView: React.FC<{
  log: LogEntry;
  index: number;
  onInstallPackage?: (moduleName: string) => void;
}> = React.memo(({ log, index, onInstallPackage }) => {
  const timestamp = useMemo(() => new Date(log.timestamp).toLocaleTimeString(), [log.timestamp]);
  const hasResult = log.result !== undefined;
  const hasImages = log.images && log.images.length > 0;
  const missingModule = missingModuleName(log);
  const sourceText = formatSourceLabel(log.errorDetails?.source ?? log.origin);
  const locationText = formatLocationLabel(log.errorDetails?.location);
  const tracebackText = log.errorDetails?.traceback?.join('\n') ?? '';
  const isAgent = log.origin?.kind === 'agent';
  const stdoutHtml = useMemo(
    () => (log.stdout ? ansiToHtml(log.stdout) : ''),
    [log.stdout],
  );
  const stderrHtml = useMemo(
    () => (log.stderr ? ansiToHtml(log.stderr) : ''),
    [log.stderr],
  );
  const errorHtml = useMemo(
    () => (log.error ? 'Error: ' + ansiToHtml(log.error) : ''),
    [log.error],
  );
  const tracebackHtml = useMemo(
    () => (tracebackText ? ansiToHtml(tracebackText) : ''),
    [tracebackText],
  );

  return (
    <div className={`log-entry${isAgent ? ' log-entry-agent' : ''}`}>
      <div className="log-entry-meta">
        <span className="log-count">[{index}]</span>
        <span className="log-time">{timestamp}</span>
        {typeof log.duration === 'number' && (
          <span className="log-duration">{Math.round(log.duration)}ms</span>
        )}
        {sourceText && <span className="log-source">{sourceText}</span>}
      </div>

      {log.code && <pre className="log-code">{log.code}</pre>}

      {log.stdout && (
        <pre
          className="log-stdout"
          dangerouslySetInnerHTML={{ __html: stdoutHtml }}
        />
      )}
      {log.stderr && (
        <pre
          className="log-stderr"
          dangerouslySetInnerHTML={{ __html: stderrHtml }}
        />
      )}
      {hasResult && <pre className="log-result">{formatResult(log.result)}</pre>}
      {log.error && <pre className="log-error" dangerouslySetInnerHTML={{ __html: errorHtml }} />}
      {log.error && locationText && <div className="log-error-context">{locationText}</div>}
      {tracebackText && (
        <pre
          className="log-traceback"
          dangerouslySetInnerHTML={{ __html: tracebackHtml }}
        />
      )}
      {onInstallPackage && missingModule && (
        <div className="log-install-action">
          <button
            className="btn btn-secondary"
            onClick={() => onInstallPackage(missingModule.name)}
            title="Install the missing package into this project's environment"
          >
            Install with {missingModule.installer}("{missingModule.name}")
          </button>
        </div>
      )}
      {hasImages && (
        <div className="log-images">
          {log.images?.map((img, idx) => (
            <img
              key={`${log.id}-img-${idx}`}
              className="log-image"
              src={`data:${img.mime};base64,${img.data}`}
              alt={`Plot ${index}.${idx + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
});
LogEntryView.displayName = 'LogEntryView';

function formatResult(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatSourceLabel(source: LogEntry['origin']): string | undefined {
  if (!source) return undefined;
  if (source.kind === 'code-cell') {
    const numericTabId =
      typeof source.tabId === 'number'
        ? source.tabId
        : source.label
          ? Number.parseInt(source.label.replace(/\D+/g, ''), 10)
          : Number.NaN;
    return Number.isFinite(numericTabId) ? `Cell ${numericTabId}` : 'Cell';
  }
  if (source.kind === 'tree-script') {
    return source.label ? `Script: ${source.label}` : 'Script';
  }
  if (source.kind === 'agent') {
    const tool = source.agentTool;
    if (tool && source.label) return `Agent · ${tool}: ${source.label}`;
    if (tool) return `Agent · ${tool}`;
    return source.label ? `Agent: ${source.label}` : 'Agent';
  }
  return source.label ? `Execution: ${source.label}` : 'Execution';
}

function formatLocationLabel(
  location: { file?: string; line?: number; column?: number } | undefined
): string | undefined {
  if (!location) return undefined;
  const parts: string[] = [];
  if (location.file) {
    parts.push(`File ${location.file}`);
  }
  if (typeof location.line === 'number') {
    parts.push(`line ${location.line}`);
  }
  if (typeof location.column === 'number') {
    parts.push(`column ${location.column}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
