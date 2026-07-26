/**
 * PathPicker — browse the session's filesystem when it isn't this machine.
 *
 * A deliberately bare quick-input: one editable path field, one entry list.
 * Type a path or click through directories; pick a file by clicking it, a
 * directory with "Select This Folder". That is all it does — it exists so a
 * remote session can open and save projects at all, and it will be replaced
 * by the planned command-palette UI rather than grown.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { ActivePickRequest } from '../../services/pick-path';
import type { ListDirResult } from '../../types';

interface PathPickerProps {
  /** The request being served; the dialog closes by resolving it. */
  request: ActivePickRequest;
  /** Unmount signal after the request resolves. */
  onDone: () => void;
}

export const PathPicker: React.FC<PathPickerProps> = ({ request, onDone }) => {
  const [input, setInput] = useState('');
  const [listing, setListing] = useState<ListDirResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic fetch counter: over a slow link two listings can resolve out
  // of order, leaving directory A's entries under an input that says B.
  const fetchSeqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const cancelDebounce = useCallback((): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const finish = useCallback(
    (path: string | null): void => {
      cancelDebounce();
      request.resolve(path);
      onDone();
    },
    [request, onDone, cancelDebounce],
  );

  const list = useCallback(async (dirPath?: string): Promise<void> => {
    // A click supersedes whatever the typing debounce was about to list —
    // without this, "type, then click .." shows the parent and then yanks
    // the view back to the typed path 400 ms later.
    cancelDebounce();
    const seq = ++fetchSeqRef.current;
    try {
      const result = await window.pdv.files.listDir(dirPath);
      if (seq !== fetchSeqRef.current) return; // superseded by a later fetch
      setListing(result);
      setInput(result.path);
      setError(null);
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      // Keep the last good listing on screen; the error names the problem
      // (ENOENT, EACCES, ENOTDIR) next to the path that caused it.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cancelDebounce]);

  useEffect(() => {
    void list(request.defaultPath);
    // Stray debounce timers must not outlive the mount (this component is
    // keyed per request, so a new pick is a fresh mount).
    return cancelDebounce;
  }, [request, list, cancelDebounce]);

  /** Typing re-lists after a pause, so the field doubles as navigation. */
  const handleInput = (value: string): void => {
    setInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void list(value);
    }, 400);
  };

  const handleEnter = (): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // The escape hatch: whatever is typed is the answer. A wrong path fails
    // loudly at the consumer (project open, kernel start), which beats
    // blocking a power user from typing a path the lister cannot reach.
    finish(input.trim() || null);
  };

  const parent = listing ? listing.path.replace(/\/[^/]+\/?$/, '') || '/' : null;
  const wantsFile = request.mode !== 'directory';

  return (
    <div className="remote-overlay path-picker-overlay">
      <div className="remote-panel path-picker-panel">
        <div className="remote-title">{request.title}</div>
        <div className="remote-subtitle">
          On the machine your session runs on. Type a path, or browse below —
          press Enter to use exactly what you typed.
        </div>
        <input
          ref={inputRef}
          className="remote-host-input path-picker-input"
          value={input}
          autoFocus
          spellCheck={false}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleEnter();
            if (e.key === 'Escape') finish(null);
          }}
        />
        {error && <div className="remote-error">{error}</div>}
        <div className="path-picker-list">
          {listing && listing.path !== '/' && (
            <button
              type="button"
              className="path-picker-entry"
              onClick={() => void list(parent ?? '/')}
            >
              <span className="path-picker-kind">▸</span>..
            </button>
          )}
          {listing?.entries
            .filter((entry) => entry.kind === 'dir' || wantsFile)
            .map((entry) => {
              const full =
                listing.path === '/' ? `/${entry.name}` : `${listing.path}/${entry.name}`;
              return (
                <button
                  type="button"
                  key={entry.name}
                  className="path-picker-entry"
                  onClick={() => {
                    if (entry.kind === 'dir') void list(full);
                    else finish(full);
                  }}
                >
                  <span className="path-picker-kind">
                    {entry.kind === 'dir' ? '▸' : ''}
                  </span>
                  {entry.kind === 'dir' ? `${entry.name}/` : entry.name}
                </button>
              );
            })}
          {listing && listing.entries.length === 0 && (
            <div className="path-picker-empty">Empty directory</div>
          )}
        </div>
        <div className="remote-actions">
          {/* Home is always available — after a failed first listing it is
              the recovery path, and `list(undefined)` needs no state. */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void list(undefined)}
          >
            Home
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => finish(null)}>
            Cancel
          </button>
          {/* Primary action rightmost, matching the app's other dialogs. */}
          {request.mode === 'directory' && listing && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => finish(listing.path)}
            >
              Select This Folder
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
