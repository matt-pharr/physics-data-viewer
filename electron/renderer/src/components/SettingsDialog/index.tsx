import React, { useEffect, useMemo, useState } from 'react';
import type { Config, Theme } from '../../../../main/ipc';

type SettingsTab = 'shortcuts' | 'appearance';
const DEFAULT_OPEN_SETTINGS_SHORTCUT = 'CommandOrControl+,';
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
  config: Config | null;
  onClose: () => void;
  onSave: (settings: NonNullable<Config['settings']>) => Promise<void>;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, config, onClose, onSave }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('shortcuts');
  const [themes, setThemes] = useState<Theme[]>([]);
  const [shortcut, setShortcut] = useState(DEFAULT_OPEN_SETTINGS_SHORTCUT);
  const [selectedTheme, setSelectedTheme] = useState('Dark');
  const [themeName, setThemeName] = useState('Dark');
  const [colors, setColors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen) return;
    const loadThemes = async () => {
      const loadedThemes = await window.pdv.themes.get();
      setThemes(loadedThemes);
      const currentThemeName = config?.settings?.appearance?.themeName ?? loadedThemes[0]?.name ?? 'Dark';
      const selected = loadedThemes.find((theme) => theme.name === currentThemeName) ?? loadedThemes[0];
      setSelectedTheme(selected?.name ?? currentThemeName);
      setThemeName(currentThemeName);
      setColors(config?.settings?.appearance?.colors ?? selected?.colors ?? {});
    };
    setShortcut(config?.settings?.shortcuts?.openSettings ?? DEFAULT_OPEN_SETTINGS_SHORTCUT);
    void loadThemes();
  }, [config, isOpen]);

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
    let savedThemeName = selectedTheme;
    if (!colorsEqual(colors, selectedThemeColors)) {
      const customThemeCount = themes.filter((theme) => theme.name.startsWith(CUSTOM_THEME_PREFIX)).length;
      savedThemeName = themeName.trim() || `${CUSTOM_THEME_PREFIX} ${customThemeCount + 1}`;
      await window.pdv.themes.save({ name: savedThemeName, colors });
    }
    await onSave({
      shortcuts: { openSettings: shortcut.trim() || DEFAULT_OPEN_SETTINGS_SHORTCUT },
      appearance: { themeName: savedThemeName, colors },
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
        </div>
        <div className="dialog-body">
          {activeTab === 'shortcuts' ? (
            <div className="settings-grid">
              <label htmlFor="settings-open-shortcut">Open Settings Shortcut</label>
              <input
                id="settings-open-shortcut"
                type="text"
                value={shortcut}
                onChange={(event) => setShortcut(event.target.value)}
              />
            </div>
          ) : (
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
              {Object.entries(colors).map(([name, value]) => (
                <React.Fragment key={name}>
                  <label htmlFor={`settings-color-${name}`}>{name}</label>
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
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void onSaveSettings()}>Save</button>
        </div>
      </div>
    </div>
  );
};
