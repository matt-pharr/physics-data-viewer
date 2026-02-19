import React, { useState, useEffect } from 'react';
import type { KeyboardShortcut } from '../../../../main/ipc';

interface KeyboardShortcutsTabProps {
  shortcuts?: KeyboardShortcut[];
  onShortcutsChange: (shortcuts: KeyboardShortcut[]) => void;
}

// Default keyboard shortcuts
const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  { action: 'Execute Code', key: 'Enter', modifiers: ['Shift'] },
  { action: 'Clear Console', key: 'K', modifiers: ['CommandOrControl'] },
  { action: 'New Tab', key: 'T', modifiers: ['CommandOrControl'] },
  { action: 'Close Tab', key: 'W', modifiers: ['CommandOrControl'] },
  { action: 'Next Tab', key: 'Tab', modifiers: ['Control'] },
  { action: 'Previous Tab', key: 'Tab', modifiers: ['Control', 'Shift'] },
  { action: 'Toggle Console', key: '`', modifiers: ['CommandOrControl'] },
  { action: 'Open Settings', key: ',', modifiers: ['CommandOrControl'] },
];

export const KeyboardShortcutsTab: React.FC<KeyboardShortcutsTabProps> = ({
  shortcuts: initialShortcuts,
  onShortcutsChange,
}) => {
  const [shortcuts, setShortcuts] = useState<KeyboardShortcut[]>(
    initialShortcuts || DEFAULT_SHORTCUTS
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingKey, setEditingKey] = useState('');
  const [editingModifiers, setEditingModifiers] = useState<string[]>([]);

  useEffect(() => {
    if (initialShortcuts) {
      setShortcuts(initialShortcuts);
    }
  }, [initialShortcuts]);

  const handleStartEdit = (index: number) => {
    setEditingIndex(index);
    setEditingKey(shortcuts[index].key);
    setEditingModifiers(shortcuts[index].modifiers || []);
  };

  const handleSaveEdit = () => {
    if (editingIndex !== null) {
      const updated = [...shortcuts];
      updated[editingIndex] = {
        ...updated[editingIndex],
        key: editingKey,
        modifiers: editingModifiers.length > 0 ? editingModifiers : [],
      };
      setShortcuts(updated);
      onShortcutsChange(updated);
      setEditingIndex(null);
      setEditingKey('');
      setEditingModifiers([]);
    }
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditingKey('');
    setEditingModifiers([]);
  };

  const handleModifierToggle = (modifier: string) => {
    if (editingModifiers.includes(modifier)) {
      setEditingModifiers(editingModifiers.filter((m) => m !== modifier));
    } else {
      setEditingModifiers([...editingModifiers, modifier]);
    }
  };

  const handleReset = async () => {
    try {
      const defaultShortcuts = await window.pdv.shortcuts.reset();
      setShortcuts(defaultShortcuts);
      onShortcutsChange(defaultShortcuts);
    } catch (error) {
      console.error('[KeyboardShortcutsTab] Failed to reset shortcuts:', error);
    }
  };

  const formatShortcut = (shortcut: KeyboardShortcut): string => {
    const parts = [...(shortcut.modifiers || []), shortcut.key];
    return parts
      .map((part) => {
        // Convert to display format
        if (part === 'CommandOrControl') return 'Ctrl/Cmd';
        if (part === 'Control') return 'Ctrl';
        if (part === 'Shift') return 'Shift';
        if (part === 'Alt') return 'Alt';
        if (part === 'Meta') return 'Cmd';
        return part;
      })
      .join(' + ');
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Keyboard Shortcuts</h3>
          <button onClick={handleReset} className="settings-btn-secondary settings-btn-small">
            Reset to Defaults
          </button>
        </div>
        
        <div className="settings-shortcuts-list">
          {shortcuts.map((shortcut, index) => (
            <div key={index} className="settings-shortcut-row">
              <div className="settings-shortcut-action">{shortcut.action}</div>
              
              {editingIndex === index ? (
                <div className="settings-shortcut-edit">
                  <div className="settings-shortcut-modifiers">
                    {['CommandOrControl', 'Shift', 'Alt'].map((mod) => (
                      <label key={mod} className="settings-checkbox-label">
                        <input
                          type="checkbox"
                          checked={editingModifiers.includes(mod)}
                          onChange={() => handleModifierToggle(mod)}
                        />
                        {mod === 'CommandOrControl' ? 'Ctrl/Cmd' : mod}
                      </label>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={editingKey}
                    onChange={(e) => setEditingKey(e.target.value)}
                    placeholder="Key"
                    className="settings-shortcut-input"
                  />
                  <div className="settings-shortcut-actions">
                    <button onClick={handleSaveEdit} className="settings-btn-small settings-btn-primary">
                      Save
                    </button>
                    <button onClick={handleCancelEdit} className="settings-btn-small settings-btn-secondary">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="settings-shortcut-value">{formatShortcut(shortcut)}</div>
                  <button
                    onClick={() => handleStartEdit(index)}
                    className="settings-btn-small settings-btn-secondary"
                  >
                    Edit
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
