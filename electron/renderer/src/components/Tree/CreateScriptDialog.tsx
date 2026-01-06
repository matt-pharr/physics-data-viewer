import React, { useEffect, useRef, useState } from 'react';

interface CreateScriptDialogProps {
  parentPath: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

export const CreateScriptDialog: React.FC<CreateScriptDialogProps> = ({ parentPath, onCreate, onCancel }) => {
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

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Create new script</h3>
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
            Script name
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancel();
                }
              }}
              placeholder="my_script"
            />
          </label>
          <div className="dialog-info-text">Will create {sanitized || 'name'}.py inside the tree folder</div>
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
