/**
 * RenameDialog — lightweight modal for renaming a tree node.
 *
 * Pre-fills with the current key and returns the sanitized new name.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface RenameDialogProps {
  currentKey: string;
  nodePath: string;
  onRename: (newName: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Rename" action. */
export const RenameDialog: React.FC<RenameDialogProps> = ({ currentKey, nodePath, onRename, onCancel }) => {
  const [name, setName] = useState(currentKey);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const sanitized = name.trim().replace(/\s+/g, '_');
  const canRename = sanitized.length > 0 && sanitized !== currentKey;

  const handleSubmit = () => {
    if (!canRename) return;
    onRename(sanitized);
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleSubmit, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Rename</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>

        <div className="dialog-body">
          <div className="script-info">
            <strong>Path</strong>
            <span className="script-path">{nodePath}</span>
          </div>
          <label>
            New name
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={currentKey}
            />
          </label>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canRename}>
            Rename
          </button>
        </div>
      </div>
    </div>
  );
};
