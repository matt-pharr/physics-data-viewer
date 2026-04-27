/**
 * CreateLibDialog — modal for new PDVLib (Python library) node creation.
 *
 * Mirrors {@link CreateScriptDialog} but emits names for the
 * ``tree:createLib`` handler. Libs can be created inside a module
 * (module-owned) or anywhere else in the tree (standalone).
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface CreateLibDialogProps {
  parentPath: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

export const CreateLibDialog: React.FC<CreateLibDialogProps> = ({ parentPath, onCreate, onCancel }) => {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Strip any ``.py`` the user typed, replace spaces with underscores,
  // then keep only Python-identifier-safe characters. The server does
  // the same normalization; we mirror it here just so the preview text
  // matches what actually lands on disk.
  const sanitized = name
    .trim()
    .replace(/\.py$/i, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
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
          <h3>Create new lib</h3>
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
            Lib name
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="helpers"
            />
          </label>
          <div className="dialog-info-text">
            Will create <code>{sanitized || 'name'}.py</code> as an importable module lib.
          </div>
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
