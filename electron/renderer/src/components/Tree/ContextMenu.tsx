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
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

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

  const actions = getActionsForNode(node);
  const estimatedHeight = actions.length * MENU_ITEM_HEIGHT;
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
      {actions.map((action) => (
        <button
          key={action.id}
          className="context-menu-item"
          disabled={action.disabled}
          onClick={() => {
            onAction(action.id, node);
            onClose();
          }}
        >
          <span className="context-menu-label">{action.label}</span>
          {actionShortcuts[action.id] && (
            <span className="context-menu-shortcut">{actionShortcuts[action.id]}</span>
          )}
        </button>
      ))}
    </div>
  );
};

/** Return menu actions allowed for the given node descriptor. */
export function getActionsForNode(node: TreeNodeData) {
  const actions: Array<{ id: string; label: string; disabled: boolean }> = [];
  const isContainer = node.type === 'mapping' || node.type === 'folder' || node.type === 'root';
  const isModule = node.type === 'module';
  const isGui = node.type === 'gui';

  // ── Primary actions (type-specific) ──

  if (isModule || isGui) {
    actions.push({ id: 'open_gui', label: 'Open GUI', disabled: false });
    actions.push({ id: 'edit_gui', label: 'Edit GUI', disabled: false });
  }

  if (isModule) {
    actions.push({ id: 'edit_module_metadata', label: 'Edit metadata...', disabled: false });
    actions.push({ id: 'export_module', label: 'Export to global store...', disabled: false });
  }

  if (node.type === 'script') {
    actions.push(
      { id: 'run', label: 'Run...', disabled: false },
      { id: 'run_defaults', label: 'Run defaults', disabled: false },
      { id: 'edit', label: 'Edit', disabled: false },
    );
  } else if (node.type === 'namelist' || node.type === 'lib') {
    actions.push({ id: 'edit', label: 'Edit', disabled: false });
  } else if (node.type === 'markdown') {
    actions.push({ id: 'open_note', label: 'Open', disabled: false });
    actions.push({ id: 'reload_note', label: 'Reload from disk', disabled: false });
  }

  // ── Refresh (all nodes) ──

  actions.push({ id: 'refresh', label: 'Refresh', disabled: false });

  // ── Creation actions (containers only) ──

  if (isContainer || isModule) {
    actions.push({ id: 'create_script', label: 'Create new script', disabled: false });
    actions.push({ id: 'create_note', label: 'Create new note', disabled: false });
    actions.push({ id: 'new_gui', label: 'Create new GUI', disabled: false });
    // Lib creation is meaningful only inside a module's subtree. The app
    // handler validates this at IPC time; we surface the option whenever
    // the user is right-clicking a container so it's discoverable.
    actions.push({ id: 'create_lib', label: 'Create new lib', disabled: false });
  }

  // ── Common actions (all nodes) ──

  actions.push(
    { id: 'print', label: 'Print', disabled: false },
    { id: 'copy_path', label: 'Copy Path', disabled: false },
    { id: 'delete', label: 'Delete', disabled: false },
  );

  return actions;
}
