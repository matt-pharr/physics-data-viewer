/**
 * SettingsDialog — consolidated settings editor UI.
 *
 * Hosts General, Keyboard Shortcuts, Appearance, Runtime, and About tabs and
 * persists updates through `window.pdv.config.set` and related preload APIs.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
  PLATFORM,
  checkForCommand,
  defaultTerminalPresetForPlatform,
  editorPresetIdForCommand,
  getTerminalPresetsForPlatform,
  isLikelyTuiEditor,
  normalizeShortcut,
  terminalPresetCheck,
} from './utils';
import { ShortcutCapture } from './ShortcutCapture';
import { AppearanceTab } from './AppearanceTab';
import { AgentsTab } from './AgentsTab';
import { GeneralTab } from './GeneralTab';
import { AboutTab } from './AboutTab';
import { PackagesTab } from './PackagesTab';
import { DEFAULT_AUTOSAVE_INTERVAL_S } from '../../app/constants';

type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'agents' | 'runtime' | 'packages' | 'about';

const DEFAULT_VSCODE_PAIR = THEME_PAIRS.find((pair) => pair.name === 'VSCode');

const TERMINAL_PRESET_OPTIONS = getTerminalPresetsForPlatform(PLATFORM);
const DEFAULT_TERMINAL_PRESET = defaultTerminalPresetForPlatform(PLATFORM);

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
  /** Active environment mode — drives the Project Environment tab content (§10.5.13). */
  environmentMode?: 'uv' | 'shared';
  /**
   * True when a kernel session is up (`ready`). Gates the Runtime tab into
   * default-runtime-only mode: selections update the global config for
   * future sessions but never stop or demote the live session (§10.5.19).
   */
  kernelRunning?: boolean;
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
  environmentMode,
  kernelRunning = false,
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
  const [terminalPreset, setTerminalPreset] = useState<TerminalPreset>(DEFAULT_TERMINAL_PRESET);
  const [terminalCustomTemplate, setTerminalCustomTemplate] = useState('');
  /** Availability of each General-tab launcher; `null` while a check is in flight. */
  const [launcherAvailability, setLauncherAvailability] = useState<{
    terminal: boolean | null;
    editor: boolean | null;
  }>({ terminal: true, editor: true });
  const [defaultSaveLocation, setDefaultSaveLocation] = useState('');
  const [workingDirBase, setWorkingDirBase] = useState('');
  const [autoSaveInterval, setAutoSaveInterval] = useState(DEFAULT_AUTOSAVE_INTERVAL_S);

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
        const [terminal, editor] = await Promise.all([
          window.pdv.launchers.checkAvailability(terminalCheck),
          window.pdv.launchers.checkAvailability(editorResolved.check),
        ]);
        if (!cancelled) setLauncherAvailability({ terminal, editor });
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, terminalCheck, editorResolved.check]);

  /** True when a selected launcher is confirmed missing — blocks Save. */
  const hasUnavailableLauncher =
    launcherAvailability.terminal === false ||
    launcherAvailability.editor === false;

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

  const applyMonacoThemeLive = useCallback((name: string) => {
    const monacoThemeName = getMonacoTheme(name, BUILTIN_THEMES);
    void loader.init().then((monaco) => {
      defineMonacoThemes(monaco);
      monaco.editor.setTheme(monacoThemeName);
    });
  }, []);

  /**
   * Re-apply the persisted appearance from `config`, discarding any live
   * preview (theme/color/font/width changes are previewed onto the document
   * as the user edits). Called on every cancel path; Save doesn't need it —
   * the config update re-applies through useThemeManager.
   */
  const revertLivePreview = useCallback(() => {
    const app = config?.settings?.appearance;
    if (app) {
      if (app.followSystemTheme) {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const activeName = (prefersDark ? app.darkTheme : app.lightTheme) ?? '';
        const colors = resolveThemeColors(activeName, savedThemes);
        if (colors) applyThemeColors(colors);
        applyMonacoThemeLive(activeName);
      } else if (app.colors) {
        applyThemeColors(app.colors);
        applyMonacoThemeLive(app.themeName ?? '');
      }
    }
    const fonts = config?.settings?.fonts;
    applyFontSettings(fonts?.codeFont, fonts?.displayFont);
    applyMarkdownSettings(config?.settings?.markdown?.maxContentWidth);
  }, [config, savedThemes, applyMonacoThemeLive]);

  const handleCancel = useCallback(() => {
    revertLivePreview();
    onClose();
  }, [revertLivePreview, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !recordingKey) handleCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleCancel, recordingKey]);

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

    // If the user has gated General-tab edits (a selected launcher isn't
    // installed) AND is saving from another tab, drop those edits from the
    // payload so we don't silently persist a broken launcher config. The
    // pending in-memory selection stays on the General tab for the user to
    // fix on a later visit.
    const dropGatedGeneralEdits =
      activeTab !== 'general' && hasUnavailableLauncher;
    const launcherUpdates = dropGatedGeneralEdits
      ? {}
      : {
          launchers: {
            terminal: terminalLauncher,
            editor: {
              fileCommand: editorCommand,
              dirCommand: editorCommand,
              isTuiEditor: editorResolved.isTui,
            },
          },
        };

    await onSave({
      ...launcherUpdates,
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

  return (
    <div className="modal-overlay">
      <div className="settings-dialog">
        <div className="dialog-header">
          <h3>Settings</h3>
          <button className="close-btn" onClick={handleCancel} aria-label="Close settings">×</button>
        </div>
        <div className="settings-tabs">
          <button className={`tab ${activeTab === 'general' ? 'active' : ''}`} onClick={() => setActiveTab('general')}>General</button>
          <button className={`tab ${activeTab === 'shortcuts' ? 'active' : ''}`} onClick={() => setActiveTab('shortcuts')}>Keyboard Shortcuts</button>
          <button className={`tab ${activeTab === 'appearance' ? 'active' : ''}`} onClick={() => setActiveTab('appearance')}>Appearance</button>
          <button className={`tab ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>Agents</button>
          <button className={`tab ${activeTab === 'runtime' ? 'active' : ''}`} onClick={() => setActiveTab('runtime')}>Default Runtime</button>
          <button className={`tab ${activeTab === 'packages' ? 'active' : ''}`} onClick={() => setActiveTab('packages')}>Project Environment</button>
          <button className={`tab ${activeTab === 'about' ? 'active' : ''}`} onClick={() => setActiveTab('about')}>About</button>
        </div>
        <div className="dialog-body">
          {activeTab === 'general' ? (
            <GeneralTab
              editorPresetId={editorPresetId}
              editorCustomCommand={editorCustomCommand}
              editorCustomIsTui={editorCustomIsTui}
              terminalPreset={terminalPreset}
              terminalCustomTemplate={terminalCustomTemplate}
              defaultSaveLocation={defaultSaveLocation}
              workingDirBase={workingDirBase}
              autoSaveInterval={autoSaveInterval}
              launcherAvailability={launcherAvailability}
              onEditorPresetIdChange={setEditorPresetId}
              onEditorCustomCommandChange={(value) => {
                setEditorCustomCommand(value);
                // Re-derive the wrap checkbox as the command changes so
                // switching to vim/nvim wraps without hunting for it.
                setEditorCustomIsTui(isLikelyTuiEditor(value));
              }}
              onEditorCustomIsTuiChange={setEditorCustomIsTui}
              onTerminalPresetChange={setTerminalPreset}
              onTerminalCustomTemplateChange={setTerminalCustomTemplate}
              onDefaultSaveLocationChange={setDefaultSaveLocation}
              onWorkingDirBaseChange={setWorkingDirBase}
              onAutoSaveIntervalChange={setAutoSaveInterval}
            />
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
            <div className="settings-runtime">
              <p className="settings-general-hint">
                The default runtime is used for the first run, sessions on an
                existing environment, and Julia. New Python projects manage
                their own environment (see the New Project dialog).
              </p>
              {kernelRunning && (
                <p className="settings-runtime-note" data-testid="runtime-future-note">
                  A session is running. Selections here become the default for
                  future sessions and do not change the current project&rsquo;s
                  environment.
                </p>
              )}
              <EnvironmentSelector
                embedded
                isFirstRun={activeLanguage === 'julia' ? !config?.juliaPath : !config?.pythonPath}
                activeLanguage={activeLanguage}
                currentPythonPath={config?.pythonPath}
                currentJuliaPath={config?.juliaPath}
                warning={envWarning}
                onSelect={onEnvSave}
              />
            </div>
          ) : activeTab === 'packages' ? (
            <PackagesTab environmentMode={environmentMode} />
          ) : activeTab === 'about' ? (
            <AboutTab
              appVersion={appVersion}
              updateInfo={updateInfo}
              onInstallUpdate={onInstallUpdate}
            />
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
            <button className="btn btn-secondary" onClick={handleCancel}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => void onSaveSettings()}
              disabled={
                (activeTab === 'shortcuts' && hasConflicts) ||
                (activeTab === 'general' && hasUnavailableLauncher)
              }
              title={
                activeTab === 'general' && hasUnavailableLauncher
                  ? 'A selected launcher is not installed — pick another option before saving'
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
