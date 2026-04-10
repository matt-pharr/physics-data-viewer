/**
 * CreateNoteDialog — lightweight modal for new markdown note creation.
 *
 * Accepts a note name, normalizes it for path safety, and returns the final
 * note key to the parent component.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface CreateNoteDialogProps {
  parentPath: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Create new note" action. */
export const CreateNoteDialog: React.FC<CreateNoteDialogProps> = ({ parentPath, onCreate, onCancel }) => {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sanitized = name.trim().replace(/\s+/g, '_');
  const canCreate = sanitized.length > 0;

  const handleSubmit = () => {
    if (!canCreate) return;
    onCreate(sanitized);
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleSubmit, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Create new note</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>

        <div className="dialog-body">
          <div className="script-info">
            <strong>Parent</strong>
            <span className="script-path">{parentPath || '(root)'}</span>
          </div>
          <label>
            Note name
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="my_note"
            />
          </label>
          <div className="dialog-info-text">Will create {sanitized || 'name'}.md inside the tree folder</div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canCreate}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
};
