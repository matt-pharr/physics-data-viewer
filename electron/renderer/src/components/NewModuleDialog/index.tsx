/**
 * NewModuleDialog — modal for creating a new empty PDVModule.
 *
 * Fronts the ``window.pdv.modules.createEmpty`` IPC (workflow B of #140).
 * Collects ``id``/``name``/``version``/``description``/``language``, runs
 * alias collision detection server-side, and closes on success. Lives at
 * app level so it can be opened from the File → New Module menu entry.
 */

import React, { useEffect, useRef, useState } from 'react';

interface NewModuleDialogProps {
  /** Whether the modal is currently visible. */
  isOpen: boolean;
  /** Default kernel language — pre-fills the language field. */
  defaultLanguage?: 'python' | 'julia';
  /** Called after a successful create; receives the created alias. */
  onCreated: (alias: string) => void;
  /** Called when the user dismisses the dialog without creating. */
  onCancel: () => void;
}

const DEFAULT_VERSION = '0.1.0';

function sanitizeId(raw: string): string {
  return raw.trim().replace(/[./\\\s]+/g, '_');
}

export const NewModuleDialog: React.FC<NewModuleDialogProps> = ({
  isOpen,
  defaultLanguage = 'python',
  onCreated,
  onCancel,
}) => {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [version, setVersion] = useState(DEFAULT_VERSION);
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<'python' | 'julia'>(defaultLanguage);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const idInputRef = useRef<HTMLInputElement>(null);

  // Reset form state every time the dialog is (re)opened so stale entries
  // from a previous open don't bleed through.
  useEffect(() => {
    if (isOpen) {
      setId('');
      setName('');
      setVersion(DEFAULT_VERSION);
      setDescription('');
      setLanguage(defaultLanguage);
      setError(undefined);
      setIsSubmitting(false);
      // Focus the id input on open — the user types here first.
      queueMicrotask(() => idInputRef.current?.focus());
    }
  }, [isOpen, defaultLanguage]);

  if (!isOpen) return null;

  const normalizedId = sanitizeId(id);
  const normalizedName = name.trim() || normalizedId;
  const normalizedVersion = version.trim() || DEFAULT_VERSION;
  const canSubmit = normalizedId.length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(undefined);
    try {
      const result = await window.pdv.modules.createEmpty({
        id: normalizedId,
        name: normalizedName,
        version: normalizedVersion,
        description: description.trim() || undefined,
        language,
      });
      if (result.success && result.alias) {
        onCreated(result.alias);
      } else if (result.status === 'conflict' && result.suggestedAlias) {
        setError(
          `A module named "${normalizedId}" already exists. Try "${result.suggestedAlias}".`,
        );
        setId(result.suggestedAlias);
      } else {
        setError(result.error ?? 'Failed to create module');
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
          <h3>New Module</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="param-input">
            <label>
              ID <span className="required">*</span>
              <span className="param-type">(stable identifier, also used as tree alias)</span>
            </label>
            <input
              ref={idInputRef}
              type="text"
              value={id}
              placeholder="e.g. my_module"
              onChange={(e) => setId(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          <div className="param-input">
            <label>
              Name
              <span className="param-type">(display name, defaults to ID)</span>
            </label>
            <input
              type="text"
              value={name}
              placeholder={normalizedId || 'My Module'}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          <div className="param-input">
            <label>
              Version
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
              placeholder="Optional short description"
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          <div className="param-input">
            <label>Language</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'python' | 'julia')}
              disabled={isSubmitting}
            >
              <option value="python">Python</option>
              <option value="julia">Julia</option>
            </select>
          </div>
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
            {isSubmitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};
