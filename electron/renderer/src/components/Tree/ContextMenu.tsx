import React, { useEffect, useRef } from 'react';
import type { TreeNodeData } from '../../types';

const MENU_WIDTH = 180;
const MENU_ITEM_HEIGHT = 32;
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

interface ContextMenuProps {
  x: number;
  y: number;
  node: TreeNodeData;
  onAction: (action: string, node: TreeNodeData) => void;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, node, onAction, onClose }) => {
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
          {action.label}
        </button>
      ))}
    </div>
  );
};

function getActionsForNode(node: TreeNodeData) {
  const actions: Array<{ id: string; label: string; disabled: boolean }> = [];
  const canCreateScript = node.type === 'dict' || node.type === 'folder' || node.type === 'root';

  if (node.type === 'script') {
    actions.push(
      { id: 'run', label: 'Run...', disabled: false },
      { id: 'edit', label: 'Edit', disabled: false },
      { id: 'reload', label: 'Reload', disabled: false },
      { id: 'view_source', label: 'View Source', disabled: false },
    );
  } else {
    actions.push({ id: 'refresh', label: 'Refresh', disabled: false });
    if (canCreateScript) {
      actions.push({ id: 'create_script', label: 'Create new script', disabled: false });
    }
    actions.push({ id: 'view', label: 'View', disabled: false });
  }

  actions.push(
    { id: 'print', label: 'Print', disabled: false },
    { id: 'copy_path', label: 'Copy Path', disabled: false },
    { id: 'delete', label: 'Delete', disabled: true },
  );

  return actions;
}
