/**
 * DuplicateDialog — lightweight modal for deep-copying a tree node to a new path.
 *
 * Pre-fills with the current dot-path and returns the destination path.
 * For file-backed nodes, shows an additional filename field.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import { FILE_BACKED_TYPES, defaultExtension } from './tree-file-utils';

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
  const [filename, setFilename] = useState(isFileBacked && ext ? copyKey + ext : '');
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
              Filename {!ext && <span className="dialog-info-text">(leave blank to keep original)</span>}
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={ext ? copyKey + ext : 'original filename'}
              />
            </label>
          )}
          <div className="dialog-info-text">All parent containers in the destination path must already exist.</div>
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
