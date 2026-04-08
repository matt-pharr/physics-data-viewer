/**
 * SettingsDialog — consolidated settings editor UI.
 *
 * Hosts General, Keyboard Shortcuts, Appearance, Runtime, and About tabs and
 * persists updates through `window.pdv.config.set` and related preload APIs.
 */

import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { Config, UpdateStatus } from '../../types';
import { SHORTCUT_LABELS, DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { Shortcuts } from '../../shortcuts';
import { EnvironmentSelector } from '../EnvironmentSelector';
import {
  BUILTIN_THEMES, BUILTIN_THEME_NAMES, THEME_PAIRS,
  applyThemeColors, colorsEqual, defineMonacoThemes, getMonacoTheme, resolveThemeColors,
  detectMonoFonts, detectDisplayFonts, applyFontSettings,
} from '../../themes';
import type { Theme } from '../../types';
import { loader } from '@monaco-editor/react';
import {
  IS_MAC,
  normalizeShortcut,
} from './utils';
import { ShortcutCapture } from './ShortcutCapture';
import { AppearanceTab } from './AppearanceTab';

type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about';

const DEFAULT_FILE_MANAGER = IS_MAC ? 'open {}' : 'xdg-open {}';
const DEFAULT_VSCODE_PAIR = THEME_PAIRS.find((pair) => pair.name === 'VSCode');

interface SettingsDialogProps {
  isOpen: boolean;
  initialTab?: SettingsTab;
  activeLanguage?: 'python' | 'julia';
  config: Config | null;
  shortcuts: Shortcuts;
  onClose: () => void;
  onSave: (updates: Partial<Config>) => Promise<void>;
  onEnvSave: (paths: { pythonPath?: string; juliaPath?: string }) => void | Promise<void>;
  envWarning?: string | null;
}

/** Top-level settings modal used by the App shell. */
export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  isOpen,
  initialTab = 'general',
  activeLanguage = 'python',
  config,
  shortcuts,
  onClose,
  onSave,
  onEnvSave,
  envWarning,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [editedShortcuts, setEditedShortcuts] = useState<Shortcuts>(shortcuts);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);

  // Appearance state
  const [savedThemes, setSavedThemes] = useState<Theme[]>([]);
  const [selectedThemeName, setSelectedThemeName] = useState<string>(BUILTIN_THEMES[0].name);
  const [editedColors, setEditedColors] = useState<Record<string, string>>(BUILTIN_THEMES[0].colors);
  const [followSystemTheme, setFollowSystemTheme] = useState(true);
  const [darkThemeName, setDarkThemeName] = useState<string>(
    DEFAULT_VSCODE_PAIR?.dark ?? BUILTIN_THEMES[0].name,
  );
  const [lightThemeName, setLightThemeName] = useState<string>(
    DEFAULT_VSCODE_PAIR?.light ?? BUILTIN_THEMES.find((t) => t.monacoTheme === 'vs')?.name ?? BUILTIN_THEMES[0].name,
  );

  // General settings state
  const [pythonEditorCmd, setPythonEditorCmd] = useState('code {}');
  const [juliaEditorCmd, setJuliaEditorCmd] = useState('code {}');
  const [fileManagerCmd, setFileManagerCmd] = useState(DEFAULT_FILE_MANAGER);

  // About tab state
  const [appVersion, setAppVersion] = useState<string>('…');
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus>({ state: 'idle' });
  const [editorFontSize, setEditorFontSize] = useState(13);
  const [editorTabSize, setEditorTabSize] = useState(4);
  const [editorWordWrap, setEditorWordWrap] = useState(true);

  // Font settings state
  const [codeFont, setCodeFont] = useState('');
  const [displayFont, setDisplayFont] = useState('');
  const [monoFonts, setMonoFonts] = useState<string[]>([]);
  const [displayFonts, setDisplayFonts] = useState<string[]>([]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from props on dialog open
    setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    /* eslint-disable react-hooks/set-state-in-effect -- intentional sync from props on dialog open */
    setEditedShortcuts(shortcuts);
    setPythonEditorCmd(config?.pythonEditorCmd ?? 'code {}');
    setJuliaEditorCmd(config?.juliaEditorCmd ?? 'code {}');
    setFileManagerCmd(config?.fileManagerCmd ?? DEFAULT_FILE_MANAGER);
    const ed = config?.settings?.editor;
    setEditorFontSize(ed?.fontSize ?? 13);
    setEditorTabSize(ed?.tabSize ?? 4);
    setEditorWordWrap(ed?.wordWrap ?? true);
    const fn = config?.settings?.fonts;
    setCodeFont(fn?.codeFont ?? '');
    setDisplayFont(fn?.displayFont ?? '');
    // Detect installed fonts once per open
    setMonoFonts(detectMonoFonts());
    setDisplayFonts(detectDisplayFonts());
    const load = async () => {
      const loaded = await window.pdv.themes.get();
      setSavedThemes(loaded);
      const allThemes = [...BUILTIN_THEMES, ...loaded];
      const app = config?.settings?.appearance;
      const activeName = app?.themeName ?? BUILTIN_THEMES[0].name;
      const baseTheme = allThemes.find((t) => t.name === activeName) ?? BUILTIN_THEMES[0];
      const activeColors = app?.colors ?? baseTheme.colors;
      setSelectedThemeName(activeName);
      setEditedColors({ ...baseTheme.colors, ...activeColors });
      setFollowSystemTheme(app?.followSystemTheme ?? true);
      setDarkThemeName(app?.darkTheme ?? (DEFAULT_VSCODE_PAIR?.dark ?? BUILTIN_THEMES[0].name));
      setLightThemeName(
        app?.lightTheme ??
          (DEFAULT_VSCODE_PAIR?.light ?? BUILTIN_THEMES.find((t) => t.monacoTheme === 'vs')?.name ?? BUILTIN_THEMES[0].name),
      );
    };
    void load();
    void window.pdv.about.getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [config, shortcuts, isOpen, initialTab]);

  // Subscribe to auto-update status pushes while the dialog is open.
  useEffect(() => {
    if (!isOpen) return;
    return window.pdv.updater.onUpdateStatus(setUpdateInfo);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !recordingKey) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, recordingKey]);

  const allThemes = useMemo(() => [...BUILTIN_THEMES, ...savedThemes], [savedThemes]);

  const baseColors = useMemo(() => {
    return allThemes.find((t) => t.name === selectedThemeName)?.colors ?? BUILTIN_THEMES[0].colors;
  }, [allThemes, selectedThemeName]);

  const isDirty = useMemo(() => !colorsEqual(editedColors, baseColors), [editedColors, baseColors]);

  /** Map from shortcut key → label of the shortcut it conflicts with, or null. */
  const shortcutConflicts = useMemo(() => {
    const keys = Object.keys(editedShortcuts) as Array<keyof Shortcuts>;
    const seen = new Map<string, keyof Shortcuts>();
    const result = new Map<keyof Shortcuts, string | null>();
    keys.forEach((k) => result.set(k, null));
    for (const k of keys) {
      const norm = normalizeShortcut(editedShortcuts[k]);
      if (!norm) continue;
      if (seen.has(norm)) {
        const other = seen.get(norm)!;
        result.set(k, SHORTCUT_LABELS[other]);
        result.set(other, SHORTCUT_LABELS[k]);
      } else {
        seen.set(norm, k);
      }
    }
    return result;
  }, [editedShortcuts]);

  const hasConflicts = useMemo(
    () => Array.from(shortcutConflicts.values()).some(Boolean),
    [shortcutConflicts],
  );

  if (!isOpen) return null;

  const applyMonacoThemeLive = (name: string) => {
    const monacoThemeName = getMonacoTheme(name, BUILTIN_THEMES);
    void loader.init().then((monaco) => {
      defineMonacoThemes(monaco);
      monaco.editor.setTheme(monacoThemeName);
    });
  };

  const handleThemeSelect = (name: string) => {
    const theme = allThemes.find((t) => t.name === name);
    if (!theme) return;
    const full = { ...editedColors, ...theme.colors };
    setSelectedThemeName(name);
    setEditedColors(full);
    applyThemeColors(full);
    applyMonacoThemeLive(name);
  };

  const handleDarkThemeSelect = (name: string) => {
    setDarkThemeName(name);
    // Live-preview only if system is currently dark
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      const colors = resolveThemeColors(name, savedThemes);
      if (colors) applyThemeColors(colors);
      applyMonacoThemeLive(name);
    }
  };

  const handleLightThemeSelect = (name: string) => {
    setLightThemeName(name);
    // Live-preview only if system is currently light
    if (!window.matchMedia('(prefers-color-scheme: dark)').matches) {
      const colors = resolveThemeColors(name, savedThemes);
      if (colors) applyThemeColors(colors);
      applyMonacoThemeLive(name);
    }
  };

  const handleColorChange = (key: string, value: string) => {
    const next = { ...editedColors, [key]: value };
    setEditedColors(next);
    document.documentElement.style.setProperty(`--${key}`, value);
  };

  const handleHexInput = (key: string, raw: string) => {
    // Accept partial input while typing; only apply when it looks like a valid hex color
    setEditedColors((prev) => ({ ...prev, [key]: raw }));
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
      document.documentElement.style.setProperty(`--${key}`, raw);
    }
  };

  const handleReset = () => {
    const full = { ...editedColors, ...baseColors };
    setEditedColors(full);
    applyThemeColors(full);
  };

  const handleDuplicate = async () => {
    const name = `${selectedThemeName} (Custom)`;
    const theme: Theme = { name, colors: { ...editedColors } };
    await window.pdv.themes.save(theme);
    const refreshed = await window.pdv.themes.get();
    setSavedThemes(refreshed);
    setSelectedThemeName(name);
  };

  const handleCodeFontChange = (font: string) => {
    setCodeFont(font);
    applyFontSettings(font || undefined, displayFont || undefined);
  };
  const handleDisplayFontChange = (font: string) => {
    setDisplayFont(font);
    applyFontSettings(codeFont || undefined, font || undefined);
  };

  const onSaveSettings = async () => {
    // Persist shortcuts
    const savedShortcuts = Object.fromEntries(
      (Object.keys(editedShortcuts) as Array<keyof typeof editedShortcuts>).map((key) => [
        key,
        editedShortcuts[key].trim() || DEFAULT_SHORTCUTS[key],
      ]),
    ) as unknown as Shortcuts;

    // Persist theme: if dirty and based on a built-in, auto-save as custom first
    let savedThemeName = selectedThemeName;
    if (!followSystemTheme && isDirty) {
      const isBuiltin = BUILTIN_THEME_NAMES.has(selectedThemeName);
      if (isBuiltin) savedThemeName = `${selectedThemeName} (Custom)`;
      await window.pdv.themes.save({ name: savedThemeName, colors: editedColors });
      const refreshed = await window.pdv.themes.get();
      setSavedThemes(refreshed);
      setSelectedThemeName(savedThemeName);
    }

    await onSave({
      pythonEditorCmd: pythonEditorCmd.trim() || 'code {}',
      juliaEditorCmd:  juliaEditorCmd.trim()  || 'code {}',
      fileManagerCmd:  fileManagerCmd.trim()  || DEFAULT_FILE_MANAGER,
      settings: {
        shortcuts: savedShortcuts,
        appearance: {
          themeName: savedThemeName,
          colors: followSystemTheme ? undefined : editedColors,
          followSystemTheme,
          darkTheme: followSystemTheme ? darkThemeName : undefined,
          lightTheme: followSystemTheme ? lightThemeName : undefined,
        },
        editor: {
          fontSize: editorFontSize,
          tabSize: editorTabSize,
          wordWrap: editorWordWrap,
        },
        fonts: {
          codeFont: codeFont || undefined,
          displayFont: displayFont || undefined,
        },
      },
    });
  };

  const shortcutSections: { title: string; keys: Array<keyof Shortcuts> }[] = [
    { title: 'Code Cells', keys: ['execute', 'newTab', 'closeTab'] },
    { title: 'Tree',        keys: ['treeCopyPath', 'treeEditScript', 'treePrint'] },
  ];

  return (
    <div className="modal-overlay">
      <div className="settings-dialog">
        <div className="dialog-header">
          <h3>Settings</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <div className="settings-tabs">
          <button className={`tab ${activeTab === 'general' ? 'active' : ''}`} onClick={() => setActiveTab('general')}>General</button>
          <button className={`tab ${activeTab === 'shortcuts' ? 'active' : ''}`} onClick={() => setActiveTab('shortcuts')}>Keyboard Shortcuts</button>
          <button className={`tab ${activeTab === 'appearance' ? 'active' : ''}`} onClick={() => setActiveTab('appearance')}>Appearance</button>
          <button className={`tab ${activeTab === 'runtime' ? 'active' : ''}`} onClick={() => setActiveTab('runtime')}>Runtime</button>
          <button className={`tab ${activeTab === 'about' ? 'active' : ''}`} onClick={() => setActiveTab('about')}>About</button>
        </div>
        <div className="dialog-body">
          {activeTab === 'general' ? (
            <div className="settings-general">
              <p className="settings-general-hint">
                Use <code>{'{}'}</code> as the file-path placeholder in commands.
                If omitted, the path is appended automatically.
              </p>
              <div className="settings-general-grid">
                <label htmlFor="sg-python-editor">Python editor</label>
                <input
                  id="sg-python-editor"
                  type="text"
                  value={pythonEditorCmd}
                  onChange={(e) => setPythonEditorCmd(e.target.value)}
                  placeholder="code {}"
                  spellCheck={false}
                />
                <div className="settings-general-desc">
                  Used when opening Python scripts from the Tree (e.g. <code>code {'{}' }</code>, <code>nvim {'{}' }</code>).
                </div>

                <label htmlFor="sg-julia-editor">Julia editor</label>
                <input
                  id="sg-julia-editor"
                  type="text"
                  value={juliaEditorCmd}
                  onChange={(e) => setJuliaEditorCmd(e.target.value)}
                  placeholder="code {}"
                  spellCheck={false}
                />
                <div className="settings-general-desc">
                  Used when opening Julia scripts (not yet in use).
                </div>

                <label htmlFor="sg-file-manager">File manager</label>
                <input
                  id="sg-file-manager"
                  type="text"
                  value={fileManagerCmd}
                  onChange={(e) => setFileManagerCmd(e.target.value)}
                  placeholder={DEFAULT_FILE_MANAGER}
                  spellCheck={false}
                />
                <div className="settings-general-desc">
                  Used to reveal files in the OS file browser (e.g.{' '}
                  <code>open {'{}' }</code> on macOS, <code>xdg-open {'{}' }</code> on Linux).
                </div>
              </div>
            </div>
          ) : activeTab === 'shortcuts' ? (
            <div className="settings-shortcuts-grid">
              {shortcutSections.map((section, si) => (
                <React.Fragment key={section.title}>
                  <div className={`shortcut-section-header${si > 0 ? ' shortcut-section-header--spaced' : ''}`}>
                    {section.title}
                  </div>
                  {section.keys.map((key) => (
                    <ShortcutCapture
                      key={key}
                      label={SHORTCUT_LABELS[key]}
                      value={editedShortcuts[key]}
                      defaultValue={DEFAULT_SHORTCUTS[key]}
                      conflictsWith={shortcutConflicts.get(key) ?? null}
                      recordingKey={recordingKey}
                      onStartRecording={setRecordingKey}
                      onStopRecording={() => setRecordingKey(null)}
                      onChange={(v) => setEditedShortcuts((prev) => ({ ...prev, [key]: v }))}
                    />
                  ))}
                </React.Fragment>
              ))}
            </div>
          ) : activeTab === 'runtime' ? (
            <EnvironmentSelector
              embedded
              isFirstRun={activeLanguage === 'julia' ? !config?.juliaPath : !config?.pythonPath}
              activeLanguage={activeLanguage}
              currentPythonPath={config?.pythonPath}
              currentJuliaPath={config?.juliaPath}
              warning={envWarning}
              onSelect={onEnvSave}
            />
          ) : activeTab === 'about' ? (
            <div className="settings-about">
              <div className="about-row">
                <span className="about-label">Version</span>
                <span className="about-value">v{appVersion}</span>
              </div>
              <div className="about-row">
                <span className="about-label">Updates</span>
                <div className="about-check-row">
                  {updateInfo.state === 'idle' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void window.pdv.updater.checkForUpdates()}
                    >
                      Check now
                    </button>
                  )}
                  {updateInfo.state === 'checking' && (
                    <span className="about-update-status">Checking for updates...</span>
                  )}
                  {updateInfo.state === 'not-available' && (
                    <span className="about-update-status about-update-status--success">Up to date</span>
                  )}
                  {updateInfo.state === 'available' && (
                    <>
                      <span className="about-update-status">v{updateInfo.version} available</span>
                      {updateInfo.canAutoUpdate !== false ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => void window.pdv.updater.downloadUpdate()}
                        >
                          Download
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void window.pdv.updater.openReleasesPage()}
                        >
                          View on GitHub
                        </button>
                      )}
                    </>
                  )}
                  {updateInfo.state === 'downloading' && (
                    <span className="about-update-status about-progress">
                      Downloading... {updateInfo.progress != null ? `${updateInfo.progress}%` : ''}
                    </span>
                  )}
                  {updateInfo.state === 'downloaded' && (
                    <>
                      <span className="about-update-status about-update-status--success">
                        v{updateInfo.version} ready
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => window.pdv.updater.installUpdate()}
                      >
                        Restart to update
                      </button>
                    </>
                  )}
                  {updateInfo.state === 'error' && (
                    <>
                      <span className="about-update-status about-update-status--error">
                        {updateInfo.error ?? 'Update check failed'}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void window.pdv.updater.checkForUpdates()}
                      >
                        Retry
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <AppearanceTab
              followSystemTheme={followSystemTheme}
              selectedThemeName={selectedThemeName}
              editedColors={editedColors}
              isDirty={isDirty}
              darkThemeName={darkThemeName}
              lightThemeName={lightThemeName}
              savedThemes={savedThemes}
              codeFont={codeFont}
              displayFont={displayFont}
              monoFonts={monoFonts}
              displayFonts={displayFonts}
              editorFontSize={editorFontSize}
              editorTabSize={editorTabSize}
              editorWordWrap={editorWordWrap}
              onFollowSystemThemeChange={setFollowSystemTheme}
              onThemeSelect={handleThemeSelect}
              onDarkThemeSelect={handleDarkThemeSelect}
              onLightThemeSelect={handleLightThemeSelect}
              onColorChange={handleColorChange}
              onHexInput={handleHexInput}
              onReset={handleReset}
              onDuplicate={handleDuplicate}
              onCodeFontChange={handleCodeFontChange}
              onDisplayFontChange={handleDisplayFontChange}
              onFontSizeChange={setEditorFontSize}
              onTabSizeChange={setEditorTabSize}
              onWordWrapChange={setEditorWordWrap}
            />
          )}
        </div>
        {activeTab !== 'runtime' && activeTab !== 'about' && (
          <div className="dialog-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => void onSaveSettings()}
              disabled={activeTab === 'shortcuts' && hasConflicts}
              title={activeTab === 'shortcuts' && hasConflicts ? 'Resolve duplicate shortcuts before saving' : undefined}
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
