/**
 * MoveDialog — lightweight modal for moving a tree node to a new path.
 *
 * Pre-fills with the current dot-path and returns the new destination path.
 * For file-backed nodes, shows an additional filename field.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import { FILE_BACKED_TYPES, defaultExtension } from './tree-file-utils';

interface MoveDialogProps {
  currentPath: string;
  nodeType: string;
  onMove: (newPath: string, filename?: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Move to..." action. */
export const MoveDialog: React.FC<MoveDialogProps> = ({ currentPath, nodeType, onMove, onCancel }) => {
  const [path, setPath] = useState(currentPath);
  const currentKey = currentPath.split('.').pop() ?? '';
  const isFileBacked = FILE_BACKED_TYPES.has(nodeType);
  const ext = defaultExtension(nodeType);
  const [filename, setFilename] = useState(isFileBacked && ext ? currentKey + ext : '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = path.trim();
  const canMove = trimmed.length > 0 && trimmed !== currentPath;

  const handleSubmit = () => {
    if (!canMove) return;
    const trimmedFilename = filename.trim();
    onMove(trimmed, isFileBacked && trimmedFilename ? trimmedFilename : undefined);
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
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="parent.child.name"
            />
          </label>
          {isFileBacked && (
            <label>
              Filename {!ext && <span className="dialog-info-text">(leave blank to keep original)</span>}
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={ext ? currentKey + ext : 'original filename'}
              />
            </label>
          )}
          <div className="dialog-info-text">All parent containers in the destination path must already exist.</div>
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
