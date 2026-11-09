/**
 * GeneralTab — launcher, directory, and autosave settings.
 *
 * Presentational tab body extracted from SettingsDialog. All persisted
 * state lives in the parent (it participates in the dialog-wide Save
 * payload); this component owns only the transient "autosave cleared"
 * status message. Mirrors the AppearanceTab extraction pattern:
 * props in, change callbacks out.
 */

import React, { useState } from 'react';
import { pickServerPath } from '../../services/pick-path';
import type { TerminalPreset } from '../../types';
import {
  CUSTOM_PRESET_ID,
  EDITOR_PRESETS,
  PLATFORM,
  TERMINAL_PRESET_LABELS,
  getTerminalPresetsForPlatform,
} from './utils';

const TERMINAL_PRESET_OPTIONS = getTerminalPresetsForPlatform(PLATFORM);

interface GeneralTabProps {
  /**
   * Host the session currently runs on, or null for this machine. The
   * directory fields below edit the SESSION's server config — on a remote
   * session that is the cluster's `~/.PDV/preferences.json`, which is not
   * obvious and reads as a duplicate of the Remote tab without a note.
   */
  remoteHost?: string | null;
  editorPresetId: string;
  /** Custom editor command template (shown when the preset is Custom…). */
  editorCustomCommand: string;
  editorCustomIsTui: boolean;
  terminalPreset: TerminalPreset;
  terminalCustomTemplate: string;
  defaultSaveLocation: string;
  workingDirBase: string;
  autoSaveInterval: number;
  /** Availability of each launcher; `null` while a check is in flight. */
  launcherAvailability: { terminal: boolean | null; editor: boolean | null };
  onEditorPresetIdChange: (id: string) => void;
  /** Also re-derives the TUI checkbox in the parent as the command changes. */
  onEditorCustomCommandChange: (command: string) => void;
  onEditorCustomIsTuiChange: (isTui: boolean) => void;
  onTerminalPresetChange: (preset: TerminalPreset) => void;
  onTerminalCustomTemplateChange: (template: string) => void;
  onDefaultSaveLocationChange: (dir: string) => void;
  onWorkingDirBaseChange: (dir: string) => void;
  onAutoSaveIntervalChange: (seconds: number) => void;
}

/** Inline "not installed" marker shown under a launcher whose check failed. */
const renderUnavailable = (state: boolean | null, kind: string): React.ReactNode =>
  state === false ? (
    <div role="alert" className="settings-general-error">
      The selected {kind} wasn't found on this system — install it or choose
      another option before saving.
    </div>
  ) : null;

/** General settings tab body (launchers, directories, autosave). */
export const GeneralTab: React.FC<GeneralTabProps> = ({
  remoteHost,
  editorPresetId,
  editorCustomCommand,
  editorCustomIsTui,
  terminalPreset,
  terminalCustomTemplate,
  defaultSaveLocation,
  workingDirBase,
  autoSaveInterval,
  launcherAvailability,
  onEditorPresetIdChange,
  onEditorCustomCommandChange,
  onEditorCustomIsTuiChange,
  onTerminalPresetChange,
  onTerminalCustomTemplateChange,
  onDefaultSaveLocationChange,
  onWorkingDirBaseChange,
  onAutoSaveIntervalChange,
}) => {
  /** Transient status message under the "Clear autosave data" button. */
  const [clearAutosaveStatus, setClearAutosaveStatus] = useState<string | null>(null);

  return (
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
          onChange={(e) => onEditorPresetIdChange(e.target.value)}
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
              onChange={(e) => onEditorCustomCommandChange(e.target.value)}
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
                onChange={(e) => onEditorCustomIsTuiChange(e.target.checked)}
              />
            </div>
            <div className="settings-general-desc">
              Required for TUI editors (<code>vim</code>, <code>nvim</code>,
              <code>nano</code>). Auto-set from the command; toggle to override.
            </div>
          </>
        )}

        <label htmlFor="sg-terminal-preset">Terminal application</label>
        <select
          id="sg-terminal-preset"
          value={terminalPreset}
          onChange={(e) => onTerminalPresetChange(e.target.value as TerminalPreset)}
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
              onChange={(e) => onTerminalCustomTemplateChange(e.target.value)}
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
      {remoteHost && (
        <p className="settings-general-hint">
          Your session runs on <strong>{remoteHost}</strong>, so these edit
          that host&rsquo;s configuration directly. Per-host values set in
          the Remote tab are re-applied every time a session starts there
          and will override what you set here.
        </p>
      )}
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
              const picked = await pickServerPath({ mode: 'directory', title: 'Choose the default save location', defaultPath: defaultSaveLocation || undefined });
              if (picked) onDefaultSaveLocationChange(picked);
            }}
          >
            Choose...
          </button>
          {defaultSaveLocation && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => onDefaultSaveLocationChange('')}
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
              const picked = await pickServerPath({ mode: 'directory', title: 'Choose the working directory base', defaultPath: workingDirBase || undefined });
              if (picked) onWorkingDirBaseChange(picked);
            }}
          >
            Choose...
          </button>
          {workingDirBase && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => onWorkingDirBaseChange('')}
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
          onChange={(e) => onAutoSaveIntervalChange(Math.max(30, parseInt(e.target.value) || 30))}
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
  );
};
