/**
 * MoveDialog — lightweight modal for moving a tree node to a new path.
 *
 * Pre-fills with the current dot-path and returns the new destination path.
 * On open, walks the tree via `treeService` to gather valid container
 * destinations and surfaces them as a native `<datalist>` autocomplete on
 * the path input.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import { treeService } from '../../services/tree';

/** Node kinds the kernel will accept as the parent of a moved node. */
const MOVE_TARGET_TYPES = new Set<string>(['folder', 'mapping']);

interface MoveDialogProps {
  currentPath: string;
  nodeType: string;
  /** Active kernel; needed to enumerate destination paths. */
  kernelId: string | null;
  onMove: (newPath: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Move to..." action. */
export const MoveDialog: React.FC<MoveDialogProps> = ({ currentPath, kernelId, onMove, onCancel }) => {
  const [path, setPath] = useState(currentPath);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const currentKey = currentPath.split('.').pop() ?? '';

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Walk the tree once on open to gather valid destination paths.
  // Each suggestion is `<container>.<currentKey>` — the full path the
  // node would have if dropped into that container — so accepting a
  // suggestion via autocomplete gives a complete move target.
  useEffect(() => {
    if (!kernelId) return;
    let cancelled = false;

    const walk = async (parent: string): Promise<string[]> => {
      const found: string[] = [];
      let nodes;
      try {
        nodes = parent === ''
          ? await treeService.getRootNodes(kernelId)
          : await treeService.listByPath(kernelId, parent);
      } catch {
        return found;
      }
      for (const node of nodes) {
        if (!MOVE_TARGET_TYPES.has(node.type)) continue;
        // Skip descendants of the moving node (can't move into self/descendants).
        if (node.path === currentPath || node.path.startsWith(currentPath + '.')) continue;
        found.push(node.path);
        if (node.hasChildren) {
          const sub = await walk(node.path);
          found.push(...sub);
        }
      }
      return found;
    };

    void (async () => {
      const containers = ['', ...(await walk(''))];
      if (cancelled) return;
      const proposed = containers
        .map((p) => (p === '' ? currentKey : `${p}.${currentKey}`))
        .filter((s) => s !== currentPath);
      setSuggestions(proposed);
    })();

    return () => {
      cancelled = true;
    };
  }, [kernelId, currentPath, currentKey]);

  const trimmed = path.trim();
  const canMove = trimmed.length > 0 && trimmed !== currentPath;

  const handleSubmit = () => {
    if (!canMove) return;
    onMove(trimmed);
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleSubmit, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Move node</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>

        <div className="dialog-body">
          <div className="script-info">
            <strong>Current path</strong>
            <span className="script-path">{currentPath}</span>
          </div>
          <label>
            New path
            <input
              ref={inputRef}
              type="text"
              list="move-dialog-destinations"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="parent.child.name"
              autoComplete="off"
            />
            <datalist id="move-dialog-destinations">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <div className="dialog-info-text">
            Pick a destination from the dropdown or type a dot-separated path.
            For example, <code>results.{currentKey}</code> moves this
            node into the <code>results</code> container.
            All parent containers must already exist.
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canMove}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
};
