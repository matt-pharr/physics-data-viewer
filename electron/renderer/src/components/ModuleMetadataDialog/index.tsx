/**
 * ModuleMetadataDialog — in-app editor for a PDVModule's mutable metadata.
 *
 * Fronts ``window.pdv.modules.updateMetadata``. Fields: ``id`` (read-only
 * after creation), ``name``, ``version``, ``description``. ``language``
 * is shown for context but also read-only — flipping languages on an
 * existing module would require rebinding its subtree, which is out of
 * scope for workflow B.
 */

import React, { useEffect, useState } from 'react';

interface ModuleMetadataDialogProps {
  isOpen: boolean;
  alias: string;
  initial: {
    name: string;
    version: string;
    description?: string;
    language?: 'python' | 'julia';
  };
  onSaved: () => void;
  onCancel: () => void;
}

export const ModuleMetadataDialog: React.FC<ModuleMetadataDialogProps> = ({
  isOpen,
  alias,
  initial,
  onSaved,
  onCancel,
}) => {
  const [name, setName] = useState(initial.name);
  const [version, setVersion] = useState(initial.version);
  const [description, setDescription] = useState(initial.description ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (isOpen) {
      setName(initial.name);
      setVersion(initial.version);
      setDescription(initial.description ?? '');
      setError(undefined);
      setIsSubmitting(false);
    }
    // We intentionally depend on isOpen only; initial is expected to be
    // fresh at open time and changing it mid-edit would clobber user
    // keystrokes. The parent closes the dialog between opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const nameTrim = name.trim();
  const versionTrim = version.trim();
  const canSubmit =
    !isSubmitting && nameTrim.length > 0 && versionTrim.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(undefined);
    try {
      const r = await window.pdv.modules.updateMetadata({
        alias,
        name: nameTrim,
        version: versionTrim,
        description: description.trim(),
      });
      if (r.success) {
        onSaved();
      } else {
        setError(r.error ?? 'Failed to update module metadata');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="script-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="dialog-header">
          <h3>Edit Module Metadata</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="param-input">
            <label>
              ID
              <span className="param-type">(read-only)</span>
            </label>
            <input type="text" value={alias} disabled />
          </div>
          <div className="param-input">
            <label>
              Name <span className="required">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          <div className="param-input">
            <label>
              Version <span className="required">*</span>
              <span className="param-type">(semver)</span>
            </label>
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          <div className="param-input">
            <label>Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          {initial.language && (
            <div className="param-input">
              <label>
                Language
                <span className="param-type">(read-only)</span>
              </label>
              <input type="text" value={initial.language} disabled />
            </div>
          )}
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {isSubmitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
