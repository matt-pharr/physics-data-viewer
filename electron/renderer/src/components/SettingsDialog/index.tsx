import React, { useEffect, useMemo, useState } from 'react';
import type { Config, Theme } from '../../types';
import { SHORTCUT_LABELS, DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { Shortcuts } from '../../shortcuts';
import { EnvironmentSelector } from '../EnvironmentSelector';

type SettingsTab = 'shortcuts' | 'appearance' | 'runtime';
const CUSTOM_THEME_PREFIX = 'Custom Theme';

function colorsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => a[key] === b[key]);
}

interface SettingsDialogProps {
  isOpen: boolean;
  initialTab?: SettingsTab;
  config: Config | null;
  shortcuts: Shortcuts;
  currentKernelId?: string | null;
  onClose: () => void;
  onSave: (updates: Partial<Config>) => Promise<void>;
  onEnvSave: (paths: { pythonPath: string; juliaPath?: string }) => Promise<void>;
  onRestart?: () => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  isOpen,
  initialTab = 'shortcuts',
  config,
  shortcuts,
  currentKernelId,
  onClose,
  onSave,
  onEnvSave,
  onRestart,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [editedShortcuts, setEditedShortcuts] = useState<Shortcuts>(shortcuts);
  const [selectedTheme, setSelectedTheme] = useState('Dark');
  const [themeName, setThemeName] = useState('Dark');
  const [colors, setColors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(initialTab);
    setEditedShortcuts(shortcuts);
    const loadThemes = async () => {
      const loadedThemes = await window.pdv.themes.get();
      setThemes(loadedThemes);
      const currentThemeName = config?.settings?.appearance?.themeName ?? loadedThemes[0]?.name ?? 'Dark';
      const selected = loadedThemes.find((theme) => theme.name === currentThemeName) ?? loadedThemes[0];
      setSelectedTheme(selected?.name ?? currentThemeName);
      setThemeName(currentThemeName);
      setColors(config?.settings?.appearance?.colors ?? selected?.colors ?? {});
    };
    void loadThemes();
  }, [config, shortcuts, isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const selectedThemeColors = useMemo(
    () => themes.find((theme) => theme.name === selectedTheme)?.colors ?? {},
    [selectedTheme, themes],
  );

  if (!isOpen) return null;

  const onThemeChange = (name: string) => {
    const theme = themes.find((entry) => entry.name === name);
    setSelectedTheme(name);
    setThemeName(name);
    setColors(theme?.colors ?? {});
  };

  const onSaveSettings = async () => {
    const requestedThemeName = themeName.trim();
    let savedThemeName = selectedTheme;
    if (requestedThemeName !== selectedTheme || !colorsEqual(colors, selectedThemeColors)) {
      const customThemeCount = themes.filter((theme) => theme.name.startsWith(CUSTOM_THEME_PREFIX)).length;
      savedThemeName = requestedThemeName || `${CUSTOM_THEME_PREFIX} ${customThemeCount + 1}`;
      await window.pdv.themes.save({ name: savedThemeName, colors });
      const loadedThemes = await window.pdv.themes.get();
      setThemes(loadedThemes);
      setSelectedTheme(savedThemeName);
    }
    // Persist all shortcuts; fall back to defaults for any blank field
    const savedShortcuts = Object.fromEntries(
      (Object.keys(editedShortcuts) as Array<keyof typeof editedShortcuts>).map((key) => [
        key,
        editedShortcuts[key].trim() || DEFAULT_SHORTCUTS[key],
      ]),
    ) as typeof editedShortcuts;
    await onSave({
      settings: {
        shortcuts: savedShortcuts,
        appearance: { themeName: savedThemeName, colors },
      },
    });
  };

  return (
    <div className="modal-overlay">
      <div className="settings-dialog">
        <div className="dialog-header">
          <h3>Settings</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <div className="settings-tabs">
          <button className={`tab ${activeTab === 'shortcuts' ? 'active' : ''}`} onClick={() => setActiveTab('shortcuts')}>Keyboard Shortcuts</button>
          <button className={`tab ${activeTab === 'appearance' ? 'active' : ''}`} onClick={() => setActiveTab('appearance')}>Appearance</button>
          <button className={`tab ${activeTab === 'runtime' ? 'active' : ''}`} onClick={() => setActiveTab('runtime')}>Python Runtime</button>
        </div>
        <div className="dialog-body">
          {activeTab === 'shortcuts' ? (
            <div className="settings-grid">
              {(Object.keys(SHORTCUT_LABELS) as Array<keyof Shortcuts>).map((key) => (
                <React.Fragment key={key}>
                  <label htmlFor={`shortcut-${key}`}>{SHORTCUT_LABELS[key]}</label>
                  <input
                    id={`shortcut-${key}`}
                    type="text"
                    value={editedShortcuts[key]}
                    onChange={(e) =>
                      setEditedShortcuts((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder={DEFAULT_SHORTCUTS[key]}
                  />
                </React.Fragment>
              ))}
            </div>
          ) : activeTab === 'runtime' ? (
            <EnvironmentSelector
              embedded
              isFirstRun={!config?.pythonPath}
              currentConfig={config || undefined}
              currentKernelId={currentKernelId}
              onSave={onEnvSave}
              onRestart={onRestart}
            />
          ) : (
            <div className="settings-appearance-layout">
              <div className="settings-card">
                <h4>Theme Selection</h4>
                <div className="settings-grid">
                  <label htmlFor="settings-theme-select">Theme</label>
                  <select id="settings-theme-select" value={selectedTheme} onChange={(event) => onThemeChange(event.target.value)}>
                    {themes.map((theme) => (
                      <option key={theme.name} value={theme.name}>
                        {theme.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="settings-theme-name">Theme Name</label>
                  <input
                    id="settings-theme-name"
                    type="text"
                    value={themeName}
                    onChange={(event) => setThemeName(event.target.value)}
                  />
                </div>
              </div>
              <div className="settings-card">
                <h4>Theme Colors</h4>
                <div className="settings-color-grid">
                  {Object.entries(colors).map(([name, value]) => (
                    <div className="settings-color-row" key={name}>
                      <label htmlFor={`settings-color-${name}`}>{name}</label>
                      <div className="settings-color-input">
                        <input
                          id={`settings-color-${name}`}
                          type="color"
                          value={value}
                          onChange={(event) =>
                            setColors((prev) => ({
                              ...prev,
                              [name]: event.target.value,
                            }))
                          }
                        />
                        <span>{value}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        {activeTab !== 'runtime' && (
          <div className="dialog-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void onSaveSettings()}>Save</button>
          </div>
        )}
      </div>
    </div>
  );
};
