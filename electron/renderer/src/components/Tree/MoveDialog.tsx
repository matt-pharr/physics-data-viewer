/**
 * MoveDialog — lightweight modal for moving a tree node to a new path.
 *
 * Pre-fills with the current dot-path and returns the new destination path.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface MoveDialogProps {
  currentPath: string;
  onMove: (newPath: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Move to..." action. */
export const MoveDialog: React.FC<MoveDialogProps> = ({ currentPath, onMove, onCancel }) => {
  const [path, setPath] = useState(currentPath);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="parent.child.name"
            />
          </label>
          <div className="dialog-info-text">Enter the full dot-separated destination path</div>
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
