import React, { useEffect, useMemo, useState } from 'react';
import type { Config } from '../../types';
import { SHORTCUT_LABELS, DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { Shortcuts } from '../../shortcuts';
import { EnvironmentSelector } from '../EnvironmentSelector';
import {
  BUILTIN_THEMES, BUILTIN_THEME_NAMES, CSS_VAR_GROUPS, THEME_PAIRS,
  applyThemeColors, colorsEqual, defineMonacoThemes, getMonacoTheme, resolveThemeColors,
} from '../../themes';
import type { Theme } from '../../types';
import { loader } from '@monaco-editor/react';

type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'runtime';

const isMac = navigator.platform.toUpperCase().startsWith('MAC');
const DEFAULT_FILE_MANAGER = isMac ? 'open {}' : 'xdg-open {}';

/** Convert a stored shortcut token to a human-readable key badge label. */
function tokenToLabel(token: string): string {
  switch (token.toLowerCase()) {
    case 'commandorcontrol': return isMac ? '⌘' : 'Ctrl';
    case 'command': case 'cmd': case 'meta': return '⌘';
    case 'control': case 'ctrl': return 'Ctrl';
    case 'shift': return '⇧';
    case 'alt': case 'option': return isMac ? '⌥' : 'Alt';
    case 'enter': case 'return': return '↵';
    case 'escape': case 'esc': return 'Esc';
    case 'tab': return '⇥';
    case 'backspace': return '⌫';
    case 'delete': return '⌦';
    case 'arrowup': return '↑';
    case 'arrowdown': return '↓';
    case 'arrowleft': return '←';
    case 'arrowright': return '→';
    case 'comma': return ',';
    case 'space': return 'Space';
    default: return token.length === 1 ? token.toUpperCase() : token;
  }
}

/** Parse a stored shortcut string into display badge labels. */
function parseShortcutTokens(shortcut: string): string[] {
  return shortcut
    .replace(/\s+/g, '')
    .split('+')
    .filter(Boolean)
    .map(tokenToLabel);
}

/** Build a stored shortcut string from a KeyboardEvent. Returns '' if only modifiers. */
function buildShortcutString(e: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (e.metaKey || e.ctrlKey) modifiers.push('CommandOrControl');
  if (e.altKey) modifiers.push('Alt');
  if (e.shiftKey) modifiers.push('Shift');

  const isModifierKey = ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key);
  if (isModifierKey) return modifiers.join('+');

  const keyStr = e.key === ',' ? 'comma'
    : e.key === ' ' ? 'Space'
    : e.key;
  return [...modifiers, keyStr].join('+');
}

/** Normalize a shortcut string for conflict comparison (case/whitespace-insensitive). */
function normalizeShortcut(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

interface ShortcutCaptureProps {
  label: string;
  value: string;
  defaultValue: string;
  conflictsWith: string | null;
  recordingKey: string | null;
  onStartRecording: (key: string) => void;
  onStopRecording: () => void;
  onChange: (v: string) => void;
}

const ShortcutCapture: React.FC<ShortcutCaptureProps> = ({
  label, value, defaultValue, conflictsWith, recordingKey, onStartRecording, onStopRecording, onChange,
}) => {
  const isRecording = recordingKey === label;
  const [livePreview, setLivePreview] = useState<string[]>([]);

  useEffect(() => {
    if (!isRecording) { setLivePreview([]); return; }

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === 'Escape') {
        onStopRecording();
        return;
      }

      const combo = buildShortcutString(e);
      const badges = combo ? combo.replace(/\s+/g, '').split('+').filter(Boolean).map(tokenToLabel) : [];
      setLivePreview(badges);

      const isModifierKey = ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key);
      if (!isModifierKey && combo) {
        onChange(combo);
        onStopRecording();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [isRecording, onChange, onStopRecording]);

  const badges = isRecording ? livePreview : parseShortcutTokens(value);
  const isDefault = value === defaultValue;

  return (
    <>
      <span>{label}</span>
      <div className={`shortcut-keys${conflictsWith ? ' shortcut-conflict' : ''}`} aria-label={`Current shortcut: ${value}`}>
        {isRecording && livePreview.length === 0 ? (
          <span className="shortcut-recording-prompt">Press keys…</span>
        ) : (
          badges.map((badge, i) => (
            <kbd key={i} className="shortcut-key-badge">{badge}</kbd>
          ))
        )}
        {conflictsWith && !isRecording && (
          <span className="shortcut-conflict-warning" title={`Conflicts with "${conflictsWith}"`}>⚠</span>
        )}
      </div>
      <div className="shortcut-actions">
        <button
          type="button"
          className={`btn-sm${isRecording ? ' recording' : ''}`}
          onClick={() => isRecording ? onStopRecording() : onStartRecording(label)}
        >
          {isRecording ? 'Cancel' : 'Set'}
        </button>
        {!isDefault && !isRecording && (
          <button
            type="button"
            className="btn-sm"
            title="Reset to default"
            onClick={() => onChange(defaultValue)}
          >
            ↺
          </button>
        )}
      </div>
    </>
  );
};


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
  const [editedShortcuts, setEditedShortcuts] = useState<Shortcuts>(shortcuts);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);

  // Appearance state
  const [savedThemes, setSavedThemes] = useState<Theme[]>([]);
  const [selectedThemeName, setSelectedThemeName] = useState<string>(BUILTIN_THEMES[0].name);
  const [editedColors, setEditedColors] = useState<Record<string, string>>(BUILTIN_THEMES[0].colors);
  const [followSystemTheme, setFollowSystemTheme] = useState(false);
  const [darkThemeName, setDarkThemeName] = useState<string>(BUILTIN_THEMES[0].name);
  const [lightThemeName, setLightThemeName] = useState<string>(
    () => BUILTIN_THEMES.find((t) => t.monacoTheme === 'vs')?.name ?? BUILTIN_THEMES[0].name,
  );

  // General settings state
  const [pythonEditorCmd, setPythonEditorCmd] = useState('code {}');
  const [juliaEditorCmd, setJuliaEditorCmd] = useState('code {}');
  const [fileManagerCmd, setFileManagerCmd] = useState(DEFAULT_FILE_MANAGER);

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(initialTab);
    setEditedShortcuts(shortcuts);
    setPythonEditorCmd(config?.pythonEditorCmd ?? 'code {}');
    setJuliaEditorCmd(config?.juliaEditorCmd ?? 'code {}');
    setFileManagerCmd(config?.fileManagerCmd ?? DEFAULT_FILE_MANAGER);
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
      setFollowSystemTheme(app?.followSystemTheme ?? false);
      setDarkThemeName(app?.darkTheme ?? BUILTIN_THEMES[0].name);
      setLightThemeName(
        app?.lightTheme ?? (BUILTIN_THEMES.find((t) => t.monacoTheme === 'vs')?.name ?? BUILTIN_THEMES[0].name),
      );
    };
    void load();
  }, [config, shortcuts, isOpen, initialTab]);

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

  const onSaveSettings = async () => {
    // Persist shortcuts
    const savedShortcuts = Object.fromEntries(
      (Object.keys(editedShortcuts) as Array<keyof typeof editedShortcuts>).map((key) => [
        key,
        editedShortcuts[key].trim() || DEFAULT_SHORTCUTS[key],
      ]),
    ) as typeof editedShortcuts;

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
      },
    });
  };

  const shortcutSections: { title: string; keys: Array<keyof Shortcuts> }[] = [
    { title: 'General',     keys: ['openSettings', 'closeWindow'] },
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
          <button className={`tab ${activeTab === 'runtime' ? 'active' : ''}`} onClick={() => setActiveTab('runtime')}>Python Runtime</button>
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
              isFirstRun={!config?.pythonPath}
              currentConfig={config || undefined}
              currentKernelId={currentKernelId}
              onSave={onEnvSave}
              onRestart={onRestart}
            />
          ) : (
            <div className="settings-appearance">
              {/* Follow system theme toggle */}
              <label className="appearance-follow-row">
                <input
                  type="checkbox"
                  checked={followSystemTheme}
                  onChange={(e) => setFollowSystemTheme(e.target.checked)}
                />
                <span>Follow system light/dark preference</span>
              </label>

              {followSystemTheme ? (
                /* Paired-theme selectors */
                <div className="appearance-pair-selectors">
                  {[
                    { label: '🌙 Dark theme', value: darkThemeName, onChange: handleDarkThemeSelect },
                    { label: '☀️ Light theme', value: lightThemeName, onChange: handleLightThemeSelect },
                  ].map(({ label, value, onChange }) => (
                    <div key={label} className="appearance-theme-row">
                      <label>{label}</label>
                      <select value={value} onChange={(e) => onChange(e.target.value)}>
                        {BUILTIN_THEMES.map((t) => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                        ))}
                        {savedThemes.length > 0 && (
                          <optgroup label="Custom">
                            {savedThemes.map((t) => (
                              <option key={t.name} value={t.name}>{t.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  ))}
                  {THEME_PAIRS.length > 0 && (
                    <div className="appearance-pair-hint">
                      Suggested pairs:{' '}
                      {THEME_PAIRS.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => { setDarkThemeName(p.dark); setLightThemeName(p.light); }}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Single theme selector row */}
                  <div className="appearance-theme-row">
                    <label htmlFor="appearance-theme-select">Theme</label>
                    <select
                      id="appearance-theme-select"
                      value={selectedThemeName}
                      onChange={(e) => handleThemeSelect(e.target.value)}
                    >
                      {BUILTIN_THEMES.map((t) => (
                        <option key={t.name} value={t.name}>{t.name}</option>
                      ))}
                      {savedThemes.length > 0 && (
                        <optgroup label="Custom">
                          {savedThemes.map((t) => (
                            <option key={t.name} value={t.name}>{t.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void handleDuplicate()}
                      title="Save a copy of this theme for editing"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleReset}
                      disabled={!isDirty}
                      title="Reset colours to this theme's defaults"
                    >
                      Reset
                    </button>
                  </div>

                  {/* Colour groups */}
                  <div className="appearance-colors">
                    {CSS_VAR_GROUPS.map((group) => (
                      <div key={group.label} className="appearance-color-group">
                        <div className="appearance-group-label">{group.label}</div>
                        {group.vars.map(({ key, label }) => {
                          const value = editedColors[key] ?? '#000000';
                          return (
                            <div key={key} className="appearance-color-row">
                              <span className="appearance-color-label">{label}</span>
                              <input
                                type="color"
                                className="appearance-color-swatch"
                                value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
                                onChange={(e) => handleColorChange(key, e.target.value)}
                              />
                              <input
                                type="text"
                                className="appearance-color-hex"
                                value={value}
                                maxLength={7}
                                spellCheck={false}
                                onChange={(e) => handleHexInput(key, e.target.value)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {activeTab !== 'runtime' && (
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
