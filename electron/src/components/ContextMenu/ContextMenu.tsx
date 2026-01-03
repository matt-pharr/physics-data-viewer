import React from 'react';

export interface ContextMenuItem {
  label: string;
  enabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ position, items, onClose }) => {
  return (
    <div
      className="context-menu"
      style={{
        position: 'fixed',
        top: position.y,
        left: position.x,
        backgroundColor: '#2d2d30',
        border: '1px solid #3e3e42',
        borderRadius: 4,
        minWidth: 180,
        zIndex: 20,
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
      }}
      role="menu"
      data-testid="context-menu"
    >
      {items.length === 0 ? (
        <div className="context-menu-item disabled">No actions available</div>
      ) : (
        items.map((item) => (
          <button
            key={item.label}
            className="context-menu-item"
            onClick={() => {
              if (item.enabled === false) {
                return;
              }
              item.onSelect();
              onClose();
            }}
            disabled={item.enabled === false}
          >
            {item.label}
          </button>
        ))
      )}
    </div>
  );
};
