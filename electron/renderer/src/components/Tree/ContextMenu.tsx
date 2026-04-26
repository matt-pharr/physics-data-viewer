/**
 * ContextMenu — right-click actions for tree nodes.
 *
 * Computes action sets by node type and displays associated shortcut hints from
 * user-configured bindings.
 */

import React, { useEffect, useRef } from 'react';
import type { TreeNodeData } from '../../types';
import type { Shortcuts } from '../../shortcuts';
import { formatShortcutHint } from '../../shortcuts';

const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 32;
const SEPARATOR_HEIGHT = 9;
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

export type MenuEntry =
  | { kind: 'action'; id: string; label: string; disabled: boolean }
  | { kind: 'separator'; id: string };

interface ContextMenuProps {
  x: number;
  y: number;
  node: TreeNodeData;
  shortcuts: Shortcuts;
  onAction: (action: string, node: TreeNodeData) => void;
  onClose: () => void;
}

/** Floating context menu anchored to the pointer location. */
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, node, shortcuts, onAction, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && e.target && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const actionShortcuts: Partial<Record<string, string>> = {
    run:       'Double-click',
    edit:      formatShortcutHint(shortcuts.treeEditScript),
    open_gui:  'Double-click',
    open_note: 'Double-click',
    print:     formatShortcutHint(shortcuts.treePrint),
    copy_path: formatShortcutHint(shortcuts.treeCopyPath),
  };

  const entries = getMenuEntries(node);
  const estimatedHeight = entries.reduce(
    (h, e) => h + (e.kind === 'separator' ? SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT),
    0,
  );
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : DEFAULT_VIEWPORT.width;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : DEFAULT_VIEWPORT.height;
  const clampedX = Math.max(0, Math.min(x, viewportWidth - MENU_WIDTH));
  const clampedY = Math.max(0, Math.min(y, viewportHeight - estimatedHeight));

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ position: 'fixed', top: clampedY, left: clampedX }}
    >
      {entries.map((entry) =>
        entry.kind === 'separator' ? (
          <div key={entry.id} className="context-menu-separator" />
        ) : (
          <button
            key={entry.id}
            className="context-menu-item"
            disabled={entry.disabled}
            onClick={() => {
              onAction(entry.id, node);
              onClose();
            }}
          >
            <span className="context-menu-label">{entry.label}</span>
            {actionShortcuts[entry.id] && (
              <span className="context-menu-shortcut">{actionShortcuts[entry.id]}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
};

/** Return menu entries (actions + separators) for the given node descriptor. */
export function getMenuEntries(node: TreeNodeData): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const isContainer = node.type === 'mapping' || node.type === 'folder' || node.type === 'root';
  const isModule = node.type === 'module';
  const isGui = node.type === 'gui';

  // ── Primary actions (type-specific) ──

  if (isModule || isGui) {
    entries.push({ kind: 'action', id: 'open_gui', label: 'Open GUI', disabled: false });
    entries.push({ kind: 'action', id: 'edit_gui', label: 'Edit GUI', disabled: false });
  }

  if (isModule) {
    entries.push({ kind: 'action', id: 'edit_module_metadata', label: 'Edit metadata...', disabled: false });
    entries.push({ kind: 'action', id: 'export_module', label: 'Export to global store...', disabled: false });
  }

  if (node.type === 'script') {
    entries.push(
      { kind: 'action', id: 'run', label: 'Run...', disabled: false },
      { kind: 'action', id: 'run_defaults', label: 'Run defaults', disabled: false },
      { kind: 'action', id: 'edit', label: 'Edit', disabled: false },
    );
  } else if (node.type === 'namelist' || node.type === 'lib') {
    entries.push({ kind: 'action', id: 'edit', label: 'Edit', disabled: false });
  } else if (node.type === 'markdown') {
    entries.push({ kind: 'action', id: 'open_note', label: 'Open', disabled: false });
    // TODO: re-enable after adding file-watcher to detect external edits
    // entries.push({ kind: 'action', id: 'edit', label: 'Open in external editor', disabled: false });
    entries.push({ kind: 'separator', id: 'sep-1' });
  }

  // ── Container actions (nodes that can have children) ──

  if (isContainer || isModule) {
    entries.push({ kind: 'action', id: 'create_node', label: 'Create new tree node', disabled: false });
    entries.push({ kind: 'action', id: 'create_script', label: 'Create new script', disabled: false });
    entries.push({ kind: 'action', id: 'create_note', label: 'Create new note', disabled: false });
    entries.push({ kind: 'action', id: 'new_gui', label: 'Create new GUI', disabled: false });
    entries.push({ kind: 'action', id: 'create_lib', label: 'Create new lib', disabled: false });
    entries.push({ kind: 'separator', id: 'sep-2' });
  }

  // ── Common actions (all nodes) ──

  entries.push({ kind: 'action', id: 'print', label: 'Print', disabled: false });
  entries.push({ kind: 'action', id: 'copy_path', label: 'Copy Path', disabled: false });
  if (node.type !== 'root') {
    entries.push({ kind: 'action', id: 'rename', label: `Rename ${renameLabel(node.type)}`, disabled: false });
    entries.push({ kind: 'action', id: 'move', label: 'Move to...', disabled: false });
    entries.push({ kind: 'action', id: 'duplicate', label: 'Duplicate to...', disabled: false });
  }
  entries.push({ kind: 'action', id: 'delete', label: 'Delete', disabled: false });

  // ── Refresh ──

  entries.push({ kind: 'separator', id: 'sep-3' });
  entries.push({ kind: 'action', id: 'refresh', label: 'Refresh tree', disabled: false });

  return entries;
}

function renameLabel(type: string): string {
  switch (type) {
    case 'script': return 'script';
    case 'markdown': return 'note';
    case 'module': return 'module';
    case 'folder': return 'folder';
    case 'gui': return 'GUI';
    case 'lib': return 'lib';
    case 'namelist': return 'namelist';
    default: return 'node';
  }
}
