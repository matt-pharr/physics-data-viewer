import React, { useState, useEffect } from 'react';
import type { Settings as SettingsType, Theme, ThemeColors, KeyboardShortcut } from '../../../main/ipc';
import { GeneralTab } from './tabs/GeneralTab';
import { AppearanceTab } from './tabs/AppearanceTab';
import { KeyboardShortcutsTab } from './tabs/KeyboardShortcutsTab';
import './styles.css';

interface SettingsProps {
  onClose: () => void;
}

type SettingsTab = 'general' | 'appearance' | 'shortcuts';

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [settings, setSettings] = useState<SettingsType>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [pythonPath, setPythonPath] = useState('');
  const [juliaPath, setJuliaPath] = useState('');
  const [pythonEditor, setPythonEditor] = useState('');
  const [juliaEditor, setJuliaEditor] = useState('');
  const [defaultEditor, setDefaultEditor] = useState('');
  const [treeRoot, setTreeRoot] = useState('');
  const [selectedThemeId, setSelectedThemeId] = useState<string | undefined>(undefined);
  const [pendingThemeColors, setPendingThemeColors] = useState<ThemeColors | undefined>(undefined);
  const [pendingThemeName, setPendingThemeName] = useState<string | undefined>(undefined);
  const [customThemeColors, setCustomThemeColors] = useState<ThemeColors | undefined>(undefined);
  const [keyboardShortcuts, setKeyboardShortcuts] = useState<KeyboardShortcut[] | undefined>(undefined);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loaded = await window.pdv.settings.get();
      setSettings(loaded);
      
      // Populate form fields
      setPythonPath(loaded.pythonPath || '');
      setJuliaPath(loaded.juliaPath || '');
      setPythonEditor(loaded.editors?.python || '');
      setJuliaEditor(loaded.editors?.julia || '');
      setDefaultEditor(loaded.editors?.default || '');
      setTreeRoot(loaded.treeRoot || '');
      setSelectedThemeId(loaded.theme);
      setCustomThemeColors(loaded.customThemeColors);
      setPendingThemeColors(loaded.customThemeColors);
      setPendingThemeName(undefined);
      setKeyboardShortcuts(loaded.keyboardShortcuts);
      
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Check if we need to create a custom theme
      let themeIdToSave = selectedThemeId;
      let colorsToSave = customThemeColors;

      if (selectedThemeId && pendingThemeColors) {
        const theme = await window.pdv.themes.load(selectedThemeId);
        if (theme) {
          // Compare both directions to detect modifications
          const allKeys = new Set([...Object.keys(pendingThemeColors), ...Object.keys(theme.colors)]);
          const isModified = Array.from(allKeys).some(
            (key) => pendingThemeColors[key] !== theme.colors[key]
          );
          
          // Also check if theme name has changed
          const nameChanged = pendingThemeName && pendingThemeName !== theme.name;
          
          if (isModified || nameChanged) {
            // Create custom theme with the pending changes
            try {
              const customTheme = await window.pdv.themes.createCustom(theme, pendingThemeColors);
              // Update the theme name if it was changed
              if (nameChanged && pendingThemeName) {
                customTheme.name = pendingThemeName;
                await window.pdv.themes.save(customTheme);
              }
              themeIdToSave = customTheme.id;
              colorsToSave = customTheme.colors;
            } catch (err) {
              console.error('[Settings] Failed to create custom theme:', err);
              setError('Failed to create custom theme');
              setSaving(false);
              return;
            }
          }
        }
      }

      const updated: Partial<SettingsType> = {
        pythonPath: pythonPath || undefined,
        juliaPath: juliaPath || undefined,
        treeRoot: treeRoot || undefined,
        theme: themeIdToSave,
        customThemeColors: colorsToSave,
        keyboardShortcuts: keyboardShortcuts,
      };

      // Only include editors if at least one field has a value
      if (pythonEditor || juliaEditor || defaultEditor) {
        updated.editors = {
          python: pythonEditor || undefined,
          julia: juliaEditor || undefined,
          default: defaultEditor || undefined,
        };
      }

      const success = await window.pdv.settings.set(updated);
      if (success) {
        onClose();
      } else {
        setError('Failed to save settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleThemeSelect = (themeId: string) => {
    setSelectedThemeId(themeId);
    // Reset pending changes when a new theme is selected
    setPendingThemeColors(undefined);
    setPendingThemeName(undefined);
  };

  const handleThemeColorsChange = (colors: ThemeColors) => {
    setPendingThemeColors(colors);
  };

  const handleThemeNameChange = (name: string) => {
    setPendingThemeName(name);
  };

  const handleShortcutsChange = (shortcuts: KeyboardShortcut[]) => {
    setKeyboardShortcuts(shortcuts);
  };

  const handleBrowsePython = async () => {
    const result = await window.pdv.files.pickExecutable();
    if (result) {
      setPythonPath(result);
    }
  };

  const handleBrowseJulia = async () => {
    const result = await window.pdv.files.pickExecutable();
    if (result) {
      setJuliaPath(result);
    }
  };

  if (loading) {
    return (
      <div className="settings-overlay">
        <div className="settings-modal">
          <div className="settings-loading">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={`settings-tab ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            Appearance
          </button>
          <button
            className={`settings-tab ${activeTab === 'shortcuts' ? 'active' : ''}`}
            onClick={() => setActiveTab('shortcuts')}
          >
            Keyboard Shortcuts
          </button>
        </div>

        <div className="settings-content">
          {error && <div className="settings-error">{error}</div>}

          {activeTab === 'general' && (
            <GeneralTab
              pythonPath={pythonPath}
              juliaPath={juliaPath}
              pythonEditor={pythonEditor}
              juliaEditor={juliaEditor}
              defaultEditor={defaultEditor}
              treeRoot={treeRoot}
              onPythonPathChange={setPythonPath}
              onJuliaPathChange={setJuliaPath}
              onPythonEditorChange={setPythonEditor}
              onJuliaEditorChange={setJuliaEditor}
              onDefaultEditorChange={setDefaultEditor}
              onTreeRootChange={setTreeRoot}
              onBrowsePython={handleBrowsePython}
              onBrowseJulia={handleBrowseJulia}
            />
          )}

          {activeTab === 'appearance' && (
            <AppearanceTab
              currentThemeId={selectedThemeId}
              customColors={pendingThemeColors || customThemeColors}
              customThemeName={pendingThemeName}
              onThemeSelect={handleThemeSelect}
              onColorsChange={handleThemeColorsChange}
              onThemeNameChange={handleThemeNameChange}
            />
          )}

          {activeTab === 'shortcuts' && (
            <KeyboardShortcutsTab
              shortcuts={keyboardShortcuts}
              onShortcutsChange={handleShortcutsChange}
            />
          )}
        </div>

        <div className="settings-footer">
          <button onClick={onClose} className="settings-btn-secondary">
            Cancel
          </button>
          <button 
            onClick={handleSave} 
            className="settings-btn-primary"
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
