import React, { useEffect, useRef } from 'react';
import type { TreeNodeData } from '../../types';

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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

  return (
    <div ref={menuRef} className="context-menu" style={{ position: 'fixed', top: y, left: x }}>
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
  const actions = [{ id: 'view', label: 'View', disabled: false }];

  if (node.type === 'ndarray' || node.type === 'dataframe') {
    actions.push({ id: 'plot', label: 'Plot', disabled: false });
  }

  if (node.type === 'file') {
    actions.push({ id: 'open', label: 'Open', disabled: false });
  }

  actions.push(
    { id: 'refresh', label: 'Refresh', disabled: false },
    // Delete is disabled until the destructive flow is implemented
    { id: 'delete', label: 'Delete', disabled: true },
  );

  return actions;
}
