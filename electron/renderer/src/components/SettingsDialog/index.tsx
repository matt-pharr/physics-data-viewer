import React, { useEffect, useMemo, useState } from 'react';
import type { Config, Theme } from '../../types';
import { SHORTCUT_LABELS, DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { Shortcuts } from '../../shortcuts';

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
  config: Config | null;
  shortcuts: Shortcuts;
  onClose: () => void;
  onSave: (updates: Partial<Config>) => Promise<void>;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, config, shortcuts, onClose, onSave }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('shortcuts');
  const [themes, setThemes] = useState<Theme[]>([]);
  const [editedShortcuts, setEditedShortcuts] = useState<Shortcuts>(shortcuts);
  const [selectedTheme, setSelectedTheme] = useState('Dark');
  const [themeName, setThemeName] = useState('Dark');
  const [colors, setColors] = useState<Record<string, string>>({});
  const [pythonPath, setPythonPath] = useState('python3');
  const [juliaPath, setJuliaPath] = useState('julia');
  const [validating, setValidating] = useState(false);
  const [runtimeErrors, setRuntimeErrors] = useState<{ python?: string; julia?: string }>({});

  useEffect(() => {
    if (!isOpen) return;
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
    setPythonPath(config?.pythonPath ?? 'python3');
    setJuliaPath(config?.juliaPath ?? 'julia');
    setRuntimeErrors({});
    void loadThemes();
  }, [config, shortcuts, isOpen]);

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
      pythonPath,
      juliaPath,
      settings: {
        shortcuts: savedShortcuts,
        appearance: { themeName: savedThemeName, colors },
      },
    });
  };

  const handleValidateRuntime = async () => {
    setValidating(true);
    setRuntimeErrors({});
    try {
      if (!window.pdv?.kernels) {
        throw new Error('PDV preload API is unavailable. Open the Electron window, not localhost in a browser.');
      }
      const pythonValid = await window.pdv.kernels.validate(pythonPath, 'python');
      const nextErrors: { python?: string; julia?: string } = {};
      if (!pythonValid.valid) nextErrors.python = pythonValid.error || 'Unable to validate Python interpreter';
      setRuntimeErrors(nextErrors);
    } catch (error) {
      setRuntimeErrors({
        python: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setValidating(false);
    }
  };

  const handlePickExecutable = async (language: 'python' | 'julia') => {
    try {
      if (!window.pdv?.files) {
        throw new Error('PDV preload API is unavailable. Open the Electron window, not localhost in a browser.');
      }
      const selected = await window.pdv.files.pickExecutable();
      if (!selected) return;
      if (language === 'python') setPythonPath(selected);
      if (language === 'julia') setJuliaPath(selected);
    } catch (error) {
      setRuntimeErrors({
        python: error instanceof Error ? error.message : String(error),
      });
    }
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
            <div className="settings-runtime">
              <div className="settings-card">
                <h4>Configure Python Runtime</h4>
                <div className="input-group">
                  <label>Python Executable</label>
                  <div className="input-with-button">
                    <input value={pythonPath} onChange={(event) => setPythonPath(event.target.value)} placeholder="/usr/bin/python3" />
                    <button className="btn btn-secondary" onClick={() => void handlePickExecutable('python')}>Browse</button>
                  </div>
                  {runtimeErrors.python && <div className="error-text">{runtimeErrors.python}</div>}
                </div>
                <div className="input-group">
                  <label>Julia Executable (deferred)</label>
                  <div className="input-with-button">
                    <input value={juliaPath} onChange={(event) => setJuliaPath(event.target.value)} placeholder="/usr/local/bin/julia" />
                    <button className="btn btn-secondary" onClick={() => void handlePickExecutable('julia')}>Browse</button>
                  </div>
                  <div className="help-text">Julia runtime validation will be available in a future release.</div>
                </div>
                <div className="button-group">
                  <button className="btn btn-secondary" onClick={() => void handleValidateRuntime()} disabled={validating}>
                    {validating ? 'Validating...' : 'Validate Paths'}
                  </button>
                </div>
              </div>
            </div>
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
        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void onSaveSettings()}>Save</button>
        </div>
      </div>
    </div>
  );
};
