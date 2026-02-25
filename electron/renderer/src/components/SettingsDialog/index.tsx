import React, { useEffect, useMemo, useState } from 'react';
import type { Config, Theme } from '../../types';
import { SHORTCUT_LABELS, DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { Shortcuts } from '../../shortcuts';
import { EnvironmentSelector } from '../EnvironmentSelector';

type SettingsTab = 'shortcuts' | 'appearance' | 'runtime';
const CUSTOM_THEME_PREFIX = 'Custom Theme';

const isMac = navigator.platform.toUpperCase().startsWith('MAC');

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
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
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
      if (e.key === 'Escape' && !recordingKey) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, recordingKey]);

  const selectedThemeColors = useMemo(
    () => themes.find((theme) => theme.name === selectedTheme)?.colors ?? {},
    [selectedTheme, themes],
  );

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
          <button className={`tab ${activeTab === 'shortcuts' ? 'active' : ''}`} onClick={() => setActiveTab('shortcuts')}>Keyboard Shortcuts</button>
          <button className={`tab ${activeTab === 'appearance' ? 'active' : ''}`} onClick={() => setActiveTab('appearance')}>Appearance</button>
          <button className={`tab ${activeTab === 'runtime' ? 'active' : ''}`} onClick={() => setActiveTab('runtime')}>Python Runtime</button>
        </div>
        <div className="dialog-body">
          {activeTab === 'shortcuts' ? (
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
