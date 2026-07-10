/**
 * CreateTreeItemDialog — shared modal for creating named tree items.
 *
 * One parameterized dialog replaces the five near-identical Create*Dialog
 * components (node, script, note, GUI, lib). Each kind supplies its title,
 * label, placeholder, preview text, and — crucially — its name sanitizer.
 * All sanitizers strip `.` (tree keys are dot-path segments; a dot inside a
 * key corrupts path addressing) and mirror the main-process normalization so
 * the preview matches what actually lands in the tree.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

/** The kinds of tree items this dialog can create. */
export type CreateTreeItemKind = 'node' | 'script' | 'note' | 'gui' | 'lib';

interface KindConfig {
  /** Dialog header text. */
  title: string;
  /** Input label text. */
  label: string;
  /** Input placeholder. */
  placeholder: string;
  /** Extension(s) stripped from the typed name before sanitizing. */
  stripExtension?: RegExp;
  /** Characters removed from the name (everything not in the kind's safe set). */
  disallowed: RegExp;
  /** Preview line under the input, given the sanitized name. */
  info: (sanitized: string) => React.ReactNode;
}

const KIND_CONFIG: Record<CreateTreeItemKind, KindConfig> = {
  node: {
    title: 'Create new tree node',
    label: 'Node name',
    placeholder: 'my_node',
    disallowed: /[^a-zA-Z0-9_-]/g,
    info: () => 'Will create an empty container node in the tree',
  },
  script: {
    title: 'Create new script',
    label: 'Script name',
    placeholder: 'my_script',
    stripExtension: /\.(py|jl)$/i,
    // Scripts are Python/Julia files whose stem becomes the tree key —
    // keep it identifier-safe, matching the main process's sanitizer.
    disallowed: /[^a-zA-Z0-9_]/g,
    info: (n) => `Will create ${n || 'name'}.py inside the tree folder`,
  },
  note: {
    title: 'Create new note',
    label: 'Note name',
    placeholder: 'my_note',
    stripExtension: /\.md$/i,
    disallowed: /[^a-zA-Z0-9_-]/g,
    info: (n) => `Will create ${n || 'name'}.md inside the tree folder`,
  },
  gui: {
    title: 'Create new GUI',
    label: 'GUI name',
    placeholder: 'my_dashboard',
    stripExtension: /\.gui\.json$/i,
    disallowed: /[^a-zA-Z0-9_-]/g,
    info: (n) => `Will create ${n || 'name'}.gui.json in the tree folder`,
  },
  lib: {
    title: 'Create new lib',
    label: 'Lib name',
    placeholder: 'helpers',
    stripExtension: /\.py$/i,
    // Libs must be importable Python modules — identifier characters only.
    disallowed: /[^a-zA-Z0-9_]/g,
    info: (n) => (
      <>
        Will create <code>{n || 'name'}.py</code> as an importable module lib.
      </>
    ),
  },
};

/**
 * Normalize a user-typed item name for the given kind: strip the kind's file
 * extension, collapse whitespace to underscores, and drop unsafe characters
 * (including `.`, which would split the key into multiple path segments).
 */
export function sanitizeTreeItemName(raw: string, kind: CreateTreeItemKind): string {
  const cfg = KIND_CONFIG[kind];
  let name = raw.trim();
  if (cfg.stripExtension) name = name.replace(cfg.stripExtension, '');
  return name.replace(/\s+/g, '_').replace(cfg.disallowed, '');
}

interface CreateTreeItemDialogProps {
  kind: CreateTreeItemKind;
  parentPath: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

/** Modal used by the Tree context menu's "Create new …" actions. */
export const CreateTreeItemDialog: React.FC<CreateTreeItemDialogProps> = ({
  kind,
  parentPath,
  onCreate,
  onCancel,
}) => {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const cfg = KIND_CONFIG[kind];
  const sanitized = sanitizeTreeItemName(name, kind);
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
          <h3>{cfg.title}</h3>
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
            {cfg.label}
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={cfg.placeholder}
            />
          </label>
          <div className="dialog-info-text">{cfg.info(sanitized)}</div>
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
