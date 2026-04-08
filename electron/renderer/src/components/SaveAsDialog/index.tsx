/**
 * SaveAsDialog — modal for saving a project with a user-chosen name and location.
 *
 * Presents a project name text field and a location picker that opens the
 * native OS directory chooser. The final save directory is
 * `<location>/<sanitized-name>/`. The dialog creates the folder automatically.
 *
 * Follows the standard modal-overlay pattern used by CreateScriptDialog,
 * ImportModuleDialog, etc.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface SaveAsDialogProps {
  /** Default parent directory shown when the dialog opens (e.g. parent of currentProjectDir). */
  defaultLocation: string | null;
  /** Default project name pre-filled in the name field (e.g. from an existing project). */
  defaultName?: string;
  /** Called when the user confirms. Receives the chosen name and full save directory path. */
  onSave: (projectName: string, saveDir: string) => void;
  /** Called when the user cancels or clicks outside. */
  onCancel: () => void;
}

/** Sanitize a project name for use as a directory name. */
function sanitizeName(raw: string): string {
  // Strip filesystem-reserved characters and ASCII control codes (\x00-\x1f).
  // eslint-disable-next-line no-control-regex
  return raw.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

export const SaveAsDialog: React.FC<SaveAsDialogProps> = ({
  defaultLocation,
  defaultName,
  onSave,
  onCancel,
}) => {
  const [name, setName] = useState(defaultName ?? '');
  const [location, setLocation] = useState(defaultLocation ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const sanitized = sanitizeName(name);
  const canSave = sanitized.length > 0 && location.length > 0;

  const handlePickLocation = async () => {
    const picked = await window.pdv.files.pickDirectory(location || undefined);
    if (picked) {
      setLocation(picked);
    }
  };

  const handleSubmit = () => {
    if (!canSave) return;
    // Build the full save directory path: <location>/<sanitizedName>
    const sep = location.endsWith('/') || location.endsWith('\\') ? '' : '/';
    const saveDir = `${location}${sep}${sanitized}`;
    onSave(name.trim(), saveDir);
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleSubmit, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="save-as-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Save Project As</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <div className="dialog-body">
          <label className="save-as-field">
            Project name
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="My Project"
            />
          </label>
          {sanitized && sanitized !== name.trim() && (
            <div className="save-as-hint">
              Folder will be named: <code>{sanitized}</code>
            </div>
          )}

          <label className="save-as-field">
            Location
            <div className="save-as-location-row">
              <span className="save-as-location-path" title={location}>
                {location || 'No location selected'}
              </span>
              <button
                className="btn btn-secondary"
                onClick={handlePickLocation}
                type="button"
              >
                Choose...
              </button>
            </div>
          </label>

          {canSave && (
            <div className="save-as-hint">
              Will save to: <code>{location}{location.endsWith('/') ? '' : '/'}{sanitized}</code>
            </div>
          )}

        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
