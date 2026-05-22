/**
 * SettingsDialog — consolidated settings editor UI.
 *
 * Hosts General, Keyboard Shortcuts, Appearance, Runtime, and About tabs and
 * persists updates through `window.pdv.config.set` and related preload APIs.
 */

import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { Config, TerminalPreset, UpdateStatus } from '../../types';
import { SHORTCUT_LABELS, DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { Shortcuts } from '../../shortcuts';
import { EnvironmentSelector } from '../EnvironmentSelector';
import {
  BUILTIN_THEMES, BUILTIN_THEME_NAMES, THEME_PAIRS, DEFAULT_READ_VIEW_MAX_WIDTH,
  applyThemeColors, colorsEqual, defineMonacoThemes, getMonacoTheme, resolveThemeColors,
  detectMonoFonts, detectDisplayFonts, applyFontSettings, applyMarkdownSettings,
} from '../../themes';
import type { Theme } from '../../types';
import { loader } from '@monaco-editor/react';
import {
  CUSTOM_PRESET_ID,
  EDITOR_PRESETS,
  TERMINAL_PRESET_LABELS,
  checkForCommand,
  defaultTerminalPresetForPlatform,
  editorPresetIdForCommand,
  fileManagerPresetIdForCommand,
  getFileManagerPresets,
  getTerminalPresetsForPlatform,
  isLikelyTuiEditor,
  normalizeShortcut,
  terminalPresetCheck,
} from './utils';
import { ShortcutCapture } from './ShortcutCapture';
import { AppearanceTab } from './AppearanceTab';
import { AgentsTab } from './AgentsTab';
import { DEFAULT_AUTOSAVE_INTERVAL_S } from '../../app/constants';

type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'agents' | 'runtime' | 'about';

const DEFAULT_VSCODE_PAIR = THEME_PAIRS.find((pair) => pair.name === 'VSCode');

/**
 * Platform identifier reported by the main process via the preload bridge.
 * `process.platform` is a constant for the life of the session, so we read it
 * synchronously rather than routing through an async IPC call. Falls back to
 * `'linux'` only if the bridge is missing (e.g. unit-test environment without
 * a preload step).
 */
const PLATFORM: NodeJS.Platform =
  (typeof window !== 'undefined' && window.pdv?.system?.platform) || 'linux';
const TERMINAL_PRESET_OPTIONS = getTerminalPresetsForPlatform(PLATFORM);
const DEFAULT_TERMINAL_PRESET = defaultTerminalPresetForPlatform(PLATFORM);
const FILE_MANAGER_OPTIONS = getFileManagerPresets(PLATFORM);

interface SettingsDialogProps {
  isOpen: boolean;
  initialTab?: SettingsTab;
  activeLanguage?: 'python' | 'julia';
  config: Config | null;
  shortcuts: Shortcuts;
  onClose: () => void;
  onSave: (updates: Partial<Config>) => Promise<void>;
  onEnvSave: (paths: { pythonPath?: string; juliaPath?: string }) => void | Promise<void>;
  /** Triggered by the "Restart to update" button. Wraps installUpdate so the
   *  caller can prompt about unsaved changes before the app restarts. */
  onInstallUpdate?: () => void;
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
  onInstallUpdate,
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

  // General settings state — launchers
  const [editorPresetId, setEditorPresetId] = useState<string>('vscode');
  const [editorCustomCommand, setEditorCustomCommand] = useState('code {}');
  const [editorCustomIsTui, setEditorCustomIsTui] = useState(false);
  const [fileManagerPresetId, setFileManagerPresetId] = useState<string>(FILE_MANAGER_OPTIONS[0].id);
  const [fileManagerCustomCommand, setFileManagerCustomCommand] = useState(FILE_MANAGER_OPTIONS[0].command);
  const [terminalPreset, setTerminalPreset] = useState<TerminalPreset>(DEFAULT_TERMINAL_PRESET);
  const [terminalCustomTemplate, setTerminalCustomTemplate] = useState('');
  /** Availability of each General-tab launcher; `null` while a check is in flight. */
  const [launcherAvailability, setLauncherAvailability] = useState<{
    terminal: boolean | null;
    editor: boolean | null;
    fileManager: boolean | null;
  }>({ terminal: true, editor: true, fileManager: true });
  const [defaultSaveLocation, setDefaultSaveLocation] = useState('');
  const [workingDirBase, setWorkingDirBase] = useState('');
  const [autoSaveInterval, setAutoSaveInterval] = useState(DEFAULT_AUTOSAVE_INTERVAL_S);
  /** Transient status message under the "Clear autosave data" button. */
  const [clearAutosaveStatus, setClearAutosaveStatus] = useState<string | null>(null);

  // About tab state
  const [appVersion, setAppVersion] = useState<string>('…');
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus>({ state: 'idle' });
  const [editorFontSize, setEditorFontSize] = useState(13);
  const [editorTabSize, setEditorTabSize] = useState(4);
  const [editorWordWrap, setEditorWordWrap] = useState(true);
  const [readViewMaxWidth, setReadViewMaxWidth] = useState(DEFAULT_READ_VIEW_MAX_WIDTH);

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
    // Editor: reverse-map the saved command to a preset (or Custom).
    const editorCfg = config?.launchers?.editor;
    const fileCmd = editorCfg?.fileCommand ?? 'code {}';
    const editorPreset = editorPresetIdForCommand(fileCmd);
    setEditorPresetId(editorPreset);
    setEditorCustomCommand(fileCmd);
    setEditorCustomIsTui(editorCfg?.isTuiEditor ?? isLikelyTuiEditor(fileCmd));
    // File manager: reverse-map likewise.
    const fmCmd = config?.fileManagerCmd;
    const fmPreset = fileManagerPresetIdForCommand(fmCmd, PLATFORM);
    setFileManagerPresetId(fmPreset);
    setFileManagerCustomCommand(fmCmd ?? FILE_MANAGER_OPTIONS[0].command);
    const savedPreset = config?.launchers?.terminal?.preset;
    setTerminalPreset(
      savedPreset && TERMINAL_PRESET_OPTIONS.includes(savedPreset)
        ? savedPreset
        : DEFAULT_TERMINAL_PRESET,
    );
    setTerminalCustomTemplate(config?.launchers?.terminal?.customTemplate ?? '');
    setDefaultSaveLocation(config?.defaultSaveLocation ?? '');
    setWorkingDirBase(config?.workingDirBase ?? '');
    setAutoSaveInterval(config?.autoSaveIntervalSeconds ?? DEFAULT_AUTOSAVE_INTERVAL_S);
    const ed = config?.settings?.editor;
    setEditorFontSize(ed?.fontSize ?? 13);
    setEditorTabSize(ed?.tabSize ?? 4);
    setEditorWordWrap(ed?.wordWrap ?? true);
    setReadViewMaxWidth(
      config?.settings?.markdown?.maxContentWidth ?? DEFAULT_READ_VIEW_MAX_WIDTH,
    );
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

  // Effective editor command + TUI flag + availability check, resolved from
  // the dropdown selection (or the Custom free-text field).
  const editorResolved = useMemo(() => {
    if (editorPresetId === CUSTOM_PRESET_ID) {
      const command = editorCustomCommand.trim() || 'code {}';
      return { command, isTui: editorCustomIsTui, check: checkForCommand(command) };
    }
    const preset = EDITOR_PRESETS.find((p) => p.id === editorPresetId) ?? EDITOR_PRESETS[0];
    return { command: preset.command, isTui: preset.isTuiEditor, check: preset.check };
  }, [editorPresetId, editorCustomCommand, editorCustomIsTui]);

  const fileManagerResolved = useMemo(() => {
    if (fileManagerPresetId === CUSTOM_PRESET_ID) {
      const command = fileManagerCustomCommand.trim() || FILE_MANAGER_OPTIONS[0].command;
      return { command, check: checkForCommand(command) };
    }
    const preset =
      FILE_MANAGER_OPTIONS.find((p) => p.id === fileManagerPresetId) ?? FILE_MANAGER_OPTIONS[0];
    return { command: preset.command, check: preset.check };
  }, [fileManagerPresetId, fileManagerCustomCommand]);

  const terminalCheck = useMemo(
    () => terminalPresetCheck(terminalPreset, PLATFORM, terminalCustomTemplate),
    [terminalPreset, terminalCustomTemplate],
  );

  // Probe each launcher's availability (debounced, so typing in a Custom
  // field doesn't fire an IPC per keystroke). Save is blocked while any
  // selected launcher is confirmed missing.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const [terminal, editor, fileManager] = await Promise.all([
          window.pdv.launchers.checkAvailability(terminalCheck),
          window.pdv.launchers.checkAvailability(editorResolved.check),
          window.pdv.launchers.checkAvailability(fileManagerResolved.check),
        ]);
        if (!cancelled) setLauncherAvailability({ terminal, editor, fileManager });
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, terminalCheck, editorResolved.check, fileManagerResolved.check]);

  /** True when a selected launcher is confirmed missing — blocks Save. */
  const hasUnavailableLauncher =
    launcherAvailability.terminal === false ||
    launcherAvailability.editor === false ||
    launcherAvailability.fileManager === false;

  // Subscribe to auto-update status pushes while the dialog is open, and
  // fetch the current cached status so we reflect any check that completed
  // before the dialog was first opened.
  useEffect(() => {
    if (!isOpen) return;
    void window.pdv.updater.getStatus().then((status) => {
      if (status) setUpdateInfo(status);
    });
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
  const handleReadViewMaxWidthChange = (width: number) => {
    setReadViewMaxWidth(width);
    applyMarkdownSettings(width);
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

    const trimmedCustom = terminalCustomTemplate.trim();
    const terminalLauncher =
      terminalPreset === 'custom'
        ? { preset: terminalPreset, customTemplate: trimmedCustom || undefined }
        : { preset: terminalPreset };

    // The collapsed editor choice drives both file-open and folder-open; the
    // `isTuiEditor` flag is now always definite (preset flag or Custom checkbox).
    const editorCommand = editorResolved.command;

    await onSave({
      fileManagerCmd: fileManagerResolved.command,
      launchers: {
        terminal: terminalLauncher,
        editor: {
          fileCommand: editorCommand,
          dirCommand: editorCommand,
          isTuiEditor: editorResolved.isTui,
        },
      },
      defaultSaveLocation: defaultSaveLocation.trim() || undefined,
      workingDirBase: workingDirBase.trim() || undefined,
      autoSaveIntervalSeconds: Math.max(30, autoSaveInterval),
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
        markdown: {
          maxContentWidth: readViewMaxWidth,
        },
      },
    });
  };

  const shortcutSections: { title: string; keys: Array<keyof Shortcuts> }[] = [
    { title: 'Code Cells', keys: ['execute', 'newTab', 'closeTab'] },
    { title: 'Tree',        keys: ['treeCopyPath', 'treeEditScript', 'treePrint'] },
  ];

  /** Inline "not installed" marker shown under a launcher whose check failed. */
  const renderUnavailable = (state: boolean | null, kind: string): React.ReactNode =>
    state === false ? (
      <div role="alert" className="settings-general-error">
        The selected {kind} wasn't found on this system — install it or choose
        another option before saving.
      </div>
    ) : null;

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
          <button className={`tab ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>Agents</button>
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
                <label htmlFor="sg-editor">Editor / IDE</label>
                <select
                  id="sg-editor"
                  value={editorPresetId}
                  onChange={(e) => setEditorPresetId(e.target.value)}
                >
                  {EDITOR_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                  <option value={CUSTOM_PRESET_ID}>Custom…</option>
                </select>
                <div className="settings-general-desc">
                  Opens a script from the Tree, and the working directory via the
                  activity-bar button.
                  {renderUnavailable(launcherAvailability.editor, 'editor')}
                </div>

                {editorPresetId === CUSTOM_PRESET_ID && (
                  <>
                    <label htmlFor="sg-editor-custom">Editor command</label>
                    <input
                      id="sg-editor-custom"
                      type="text"
                      value={editorCustomCommand}
                      onChange={(e) => {
                        const value = e.target.value;
                        setEditorCustomCommand(value);
                        // Re-derive the wrap checkbox as the command changes so
                        // switching to vim/nvim wraps without hunting for it.
                        setEditorCustomIsTui(isLikelyTuiEditor(value));
                      }}
                      placeholder="code {}"
                      spellCheck={false}
                    />
                    <div className="settings-general-desc">
                      Use <code>{'{}'}</code> as the file/folder path placeholder.
                    </div>

                    <label htmlFor="sg-editor-tui">Run in terminal</label>
                    <div className="settings-general-check">
                      <input
                        id="sg-editor-tui"
                        type="checkbox"
                        checked={editorCustomIsTui}
                        onChange={(e) => setEditorCustomIsTui(e.target.checked)}
                      />
                    </div>
                    <div className="settings-general-desc">
                      Required for TUI editors (<code>vim</code>, <code>nvim</code>,
                      <code>nano</code>). Auto-set from the command; toggle to override.
                    </div>
                  </>
                )}

                <label htmlFor="sg-file-manager">File manager</label>
                <select
                  id="sg-file-manager"
                  value={fileManagerPresetId}
                  onChange={(e) => setFileManagerPresetId(e.target.value)}
                >
                  {FILE_MANAGER_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                  <option value={CUSTOM_PRESET_ID}>Custom…</option>
                </select>
                <div className="settings-general-desc">
                  Used to reveal files in the OS file browser.
                  {renderUnavailable(launcherAvailability.fileManager, 'file manager')}
                </div>

                {fileManagerPresetId === CUSTOM_PRESET_ID && (
                  <>
                    <label htmlFor="sg-file-manager-custom">File-manager command</label>
                    <input
                      id="sg-file-manager-custom"
                      type="text"
                      value={fileManagerCustomCommand}
                      onChange={(e) => setFileManagerCustomCommand(e.target.value)}
                      placeholder="xdg-open {}"
                      spellCheck={false}
                    />
                    <div className="settings-general-desc">
                      Use <code>{'{}'}</code> as the path placeholder.
                    </div>
                  </>
                )}

                <label htmlFor="sg-terminal-preset">Terminal application</label>
                <select
                  id="sg-terminal-preset"
                  value={terminalPreset}
                  onChange={(e) => setTerminalPreset(e.target.value as TerminalPreset)}
                >
                  {TERMINAL_PRESET_OPTIONS.map((preset) => (
                    <option key={preset} value={preset}>{TERMINAL_PRESET_LABELS[preset]}</option>
                  ))}
                </select>
                <div className="settings-general-desc">
                  Wraps TUI editors (<code>vim</code>, <code>nvim</code>, <code>nano</code>, …) so they open in a real
                  terminal window. Leave on the platform default unless you have a preferred terminal.
                  {renderUnavailable(launcherAvailability.terminal, 'terminal')}
                  {terminalPreset === 'none' && (
                    <div role="alert" className="settings-general-warn">
                      TUI editors will not work without a terminal wrapper. Use this option only with
                      GUI editors that PDV's allowlist misclassifies (e.g. <code>nvim-qt</code>).
                    </div>
                  )}
                </div>

                {terminalPreset === 'custom' && (
                  <>
                    <label htmlFor="sg-terminal-custom">Custom template</label>
                    <input
                      id="sg-terminal-custom"
                      type="text"
                      value={terminalCustomTemplate}
                      onChange={(e) => setTerminalCustomTemplate(e.target.value)}
                      placeholder="alacritty -e {cmd}"
                      spellCheck={false}
                    />
                    <div className="settings-general-desc">
                      Use <code>{'{cmd}'}</code> to splice the editor command as separate arguments
                      (most terminals), or <code>{'{cmdstr}'}</code> for a quoted shell string
                      (AppleScript wrappers like Terminal.app / iTerm2). Quote paths containing
                      spaces with <code>{'"…"'}</code>; on Windows always quote paths so backslash
                      separators are preserved.
                    </div>
                  </>
                )}
              </div>


              <h4 className="settings-general-section">Directories</h4>
              <div className="settings-general-grid">
                <label htmlFor="sg-default-save">Default save location</label>
                <div className="settings-general-dir-row">
                  <span className="settings-general-dir-path" title={defaultSaveLocation}>
                    {defaultSaveLocation || 'Not set'}
                  </span>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={async () => {
                      const picked = await window.pdv.files.pickDirectory(defaultSaveLocation || undefined);
                      if (picked) setDefaultSaveLocation(picked);
                    }}
                  >
                    Choose...
                  </button>
                  {defaultSaveLocation && (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => setDefaultSaveLocation('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="settings-general-desc">
                  Pre-filled location in the Save As dialog for new projects.
                </div>

                <label htmlFor="sg-working-dir">Working directory</label>
                <div className="settings-general-dir-row">
                  <span className="settings-general-dir-path" title={workingDirBase}>
                    {workingDirBase || 'Default (~/.PDV/working/)'}
                  </span>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={async () => {
                      const picked = await window.pdv.files.pickDirectory(workingDirBase || undefined);
                      if (picked) setWorkingDirBase(picked);
                    }}
                  >
                    Choose...
                  </button>
                  {workingDirBase && (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => setWorkingDirBase('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="settings-general-desc">
                  Base directory for temporary session files. Use a fast local drive on HPC systems.
                  Takes effect on next kernel start.
                </div>
              </div>

              <h4 className="settings-general-section">Autosave</h4>
              <div className="settings-general-grid">
                <label htmlFor="sg-autosave-interval">Interval (seconds)</label>
                <input
                  id="sg-autosave-interval"
                  type="number"
                  min={30}
                  value={autoSaveInterval}
                  onChange={(e) => setAutoSaveInterval(Math.max(30, parseInt(e.target.value) || 30))}
                />
                <div className="settings-general-desc">
                  How often to automatically save project state. Minimum 30 seconds.
                </div>

                <label>Clear autosave data</label>
                <div>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => {
                      if (!window.confirm(
                        "Permanently delete autosaved data for the current project? This cannot be undone."
                      )) return;
                      void window.pdv.autosave.clear().then(
                        () => {
                          setClearAutosaveStatus("Autosave data cleared.");
                          window.setTimeout(() => setClearAutosaveStatus(null), 4000);
                        },
                        (err) => {
                          setClearAutosaveStatus(
                            `Failed to clear: ${err instanceof Error ? err.message : String(err)}`
                          );
                        },
                      );
                    }}
                  >
                    Clear
                  </button>
                </div>
                <div className="settings-general-desc">
                  Remove cached autosave files for the current project.
                  {clearAutosaveStatus && (
                    <div style={{ marginTop: 4, color: 'var(--accent)' }}>
                      {clearAutosaveStatus}
                    </div>
                  )}
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
          ) : activeTab === 'agents' ? (
            <AgentsTab />
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
              <div className="about-hero">
                {/* Paths copied verbatim from `assets/pdv-icon.svg` (the
                    desktop app icon). The rounded-square background path
                    is omitted — the About tab already sits on the dialog
                    bg so the mark works floating. Theme-aware color
                    mapping:
                      • Two faint electron-shell rings → `currentColor`
                        at the asset's original 0.10 / 0.14 opacities.
                      • Darker nucleons (TL, BR) → `var(--accent)`.
                      • Lighter nucleons (TR, BL) → an opaque paler
                        accent via `color-mix`. Using opacity instead
                        broke the two-tone effect: where a translucent
                        lighter nucleon overlapped a fully-opaque darker
                        one (both `var(--accent)`), the blend collapsed
                        to solid accent and the lighter circle visibly
                        "bit into" the darker neighbor. Mixing with
                        white at the fill layer produces a separate
                        opaque color, matching the asset's original
                        #afa9ec-on-top-of-#7f77dd behaviour. */}
                <svg
                  className="about-hero-logo"
                  viewBox="0 0 1024 1024"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    fill="currentColor"
                    opacity="0.1"
                    d="M 987.428589 512 C 987.428589 774.571899 774.571899 987.428589 512 987.428589 C 249.428055 987.428589 36.57143 774.571899 36.57143 512 C 36.57143 249.42804 249.428055 36.571411 512 36.571411 C 774.571899 36.571411 987.428589 249.42804 987.428589 512 Z"
                  />
                  <path
                    fill="currentColor"
                    opacity="0.14"
                    d="M 914.285706 512 C 914.285706 734.17627 734.17627 914.285706 512 914.285706 C 289.82373 914.285706 109.714287 734.17627 109.714287 512 C 109.714287 289.82373 289.82373 109.714294 512 109.714294 C 734.17627 109.714294 914.285706 289.82373 914.285706 512 Z"
                  />
                  <path
                    fill="var(--accent)"
                    d="M 603.428589 420.571411 C 603.428589 521.560669 521.560669 603.428589 420.571442 603.428589 C 319.582214 603.428589 237.714279 521.560669 237.714279 420.571411 C 237.714279 319.582153 319.582214 237.714294 420.571442 237.714294 C 521.560669 237.714294 603.428589 319.582153 603.428589 420.571411 Z"
                  />
                  <path
                    fill="color-mix(in srgb, var(--accent) 60%, white)"
                    d="M 786.285706 420.571411 C 786.285706 521.560669 704.417786 603.428589 603.428589 603.428589 C 502.439362 603.428589 420.571442 521.560669 420.571442 420.571411 C 420.571442 319.582153 502.439362 237.714294 603.428589 237.714294 C 704.417786 237.714294 786.285706 319.582153 786.285706 420.571411 Z"
                  />
                  <path
                    fill="color-mix(in srgb, var(--accent) 60%, white)"
                    d="M 603.428589 603.428589 C 603.428589 704.417725 521.560669 786.285706 420.571442 786.285706 C 319.582214 786.285706 237.714279 704.417725 237.714279 603.428589 C 237.714279 502.439331 319.582214 420.571411 420.571442 420.571411 C 521.560669 420.571411 603.428589 502.439331 603.428589 603.428589 Z"
                  />
                  <path
                    fill="var(--accent)"
                    d="M 786.285706 603.428589 C 786.285706 704.417725 704.417786 786.285706 603.428589 786.285706 C 502.439362 786.285706 420.571442 704.417725 420.571442 603.428589 C 420.571442 502.439331 502.439362 420.571411 603.428589 420.571411 C 704.417786 420.571411 786.285706 502.439331 786.285706 603.428589 Z"
                  />
                </svg>
                <div className="about-hero-text">
                  <div className="about-name-line">Physics Data Viewer v{appVersion}</div>
                  <div className="about-build-line">
                    Build {__BUILD_SHA__} · {new Date(__BUILD_TIME__).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                  </div>
                </div>
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
                        onClick={() => {
                          if (onInstallUpdate) {
                            onInstallUpdate();
                          } else {
                            void window.pdv.updater.installUpdate();
                          }
                        }}
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

              <div className="about-links">
                <button
                  type="button"
                  className="about-link"
                  onClick={() => void window.pdv.about.openDocsPage()}
                >
                  Docs
                </button>
                <span className="about-link-sep">·</span>
                <button
                  type="button"
                  className="about-link"
                  onClick={() => void window.pdv.about.openRepoPage()}
                >
                  Source
                </button>
                <span className="about-link-sep">·</span>
                <button
                  type="button"
                  className="about-link"
                  onClick={() => void window.pdv.about.openIssuesPage()}
                >
                  Report a bug
                </button>
                <span className="about-link-sep">·</span>
                <button
                  type="button"
                  className="about-link"
                  onClick={() => void window.pdv.updater.openReleasesPage()}
                >
                  Releases
                </button>
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
              readViewMaxWidth={readViewMaxWidth}
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
              onReadViewMaxWidthChange={handleReadViewMaxWidthChange}
            />
          )}
        </div>
        {activeTab !== 'runtime' && activeTab !== 'about' && activeTab !== 'agents' && (
          <div className="dialog-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => void onSaveSettings()}
              disabled={
                (activeTab === 'shortcuts' && hasConflicts) || hasUnavailableLauncher
              }
              title={
                hasUnavailableLauncher
                  ? 'A selected launcher is not installed — fix it on the General tab before saving'
                  : activeTab === 'shortcuts' && hasConflicts
                    ? 'Resolve duplicate shortcuts before saving'
                    : undefined
              }
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
