/**
 * DuplicateDialog — lightweight modal for deep-copying a tree node to a new path.
 *
 * Pre-fills with the current dot-path and returns the destination path.
 * For file-backed nodes, shows an additional filename field.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

const FILE_BACKED_TYPES = new Set(['script', 'markdown', 'gui', 'lib', 'namelist']);

function defaultExtension(type: string): string {
  switch (type) {
    case 'script': return '.py';
    case 'lib': return '.py';
    case 'markdown': return '.md';
    case 'gui': return '.gui.json';
    default: return '';
  }
}

interface DuplicateDialogProps {
  currentPath: string;
  nodeType: string;
  onDuplicate: (newPath: string, filename?: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Duplicate to..." action. */
export const DuplicateDialog: React.FC<DuplicateDialogProps> = ({ currentPath, nodeType, onDuplicate, onCancel }) => {
  const defaultKey = currentPath.split('.').pop() ?? '';
  const copyKey = defaultKey + '_copy';
  const parentSegments = currentPath.split('.');
  parentSegments[parentSegments.length - 1] = copyKey;
  const defaultPath = parentSegments.join('.');

  const [path, setPath] = useState(defaultPath);
  const isFileBacked = FILE_BACKED_TYPES.has(nodeType);
  const ext = defaultExtension(nodeType);
  const [filename, setFilename] = useState(isFileBacked ? copyKey + ext : '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = path.trim();
  const canDuplicate = trimmed.length > 0 && trimmed !== currentPath;

  const handleSubmit = () => {
    if (!canDuplicate) return;
    const trimmedFilename = filename.trim();
    onDuplicate(trimmed, isFileBacked && trimmedFilename ? trimmedFilename : undefined);
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleSubmit, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Duplicate node</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>

        <div className="dialog-body">
          <div className="script-info">
            <strong>Source</strong>
            <span className="script-path">{currentPath}</span>
          </div>
          <label>
            Destination path
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
              Filename
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={copyKey + ext}
              />
            </label>
          )}
          <div className="dialog-info-text">Creates an independent deep copy at the destination</div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canDuplicate}>
            Duplicate
          </button>
        </div>
      </div>
    </div>
  );
};
