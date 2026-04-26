/**
 * AppearanceTab — presentational component for the Appearance settings tab.
 *
 * Renders theme selection, colour editing, font pickers, and editor settings.
 * All state and mutation handlers are owned by the parent SettingsDialog.
 */

import React, { useState } from 'react';
import type { Theme } from '../../types';
import { BUILTIN_THEMES, CSS_VAR_GROUPS, THEME_PAIRS } from '../../themes';

export interface AppearanceTabProps {
  // Theme state
  followSystemTheme: boolean;
  selectedThemeName: string;
  editedColors: Record<string, string>;
  isDirty: boolean;
  darkThemeName: string;
  lightThemeName: string;
  savedThemes: Theme[];
  // Font state
  codeFont: string;
  displayFont: string;
  monoFonts: string[];
  displayFonts: string[];
  // Editor state
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;
  // Markdown state
  readViewMaxWidth: number;
  // Theme handlers
  onFollowSystemThemeChange: (checked: boolean) => void;
  onThemeSelect: (name: string) => void;
  onDarkThemeSelect: (name: string) => void;
  onLightThemeSelect: (name: string) => void;
  onColorChange: (key: string, value: string) => void;
  onHexInput: (key: string, raw: string) => void;
  onReset: () => void;
  onDuplicate: () => void;
  // Font handlers
  onCodeFontChange: (font: string) => void;
  onDisplayFontChange: (font: string) => void;
  // Editor handlers
  onFontSizeChange: (size: number) => void;
  onTabSizeChange: (size: number) => void;
  onWordWrapChange: (checked: boolean) => void;
  // Markdown handlers
  onReadViewMaxWidthChange: (width: number) => void;
}

export const AppearanceTab: React.FC<AppearanceTabProps> = ({
  followSystemTheme,
  selectedThemeName,
  editedColors,
  isDirty,
  darkThemeName,
  lightThemeName,
  savedThemes,
  codeFont,
  displayFont,
  monoFonts,
  displayFonts,
  editorFontSize,
  editorTabSize,
  editorWordWrap,
  readViewMaxWidth,
  onFollowSystemThemeChange,
  onThemeSelect,
  onDarkThemeSelect,
  onLightThemeSelect,
  onColorChange,
  onHexInput,
  onReset,
  onDuplicate,
  onCodeFontChange,
  onDisplayFontChange,
  onFontSizeChange,
  onTabSizeChange,
  onWordWrapChange,
  onReadViewMaxWidthChange,
}) => {
  const [importWarning, setImportWarning] = useState('');

  return (
  <div className="settings-appearance">

    {/* ── Theme section ── */}
    <div className="appearance-section-header appearance-section-header--spaced">
      Theme
      <span className="appearance-header-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => window.pdv.themes.openDir()}
          title="Open themes directory in file manager"
        >
          Open themes directory
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setImportWarning('⚠ VS Code theme import is not yet implemented.')}
          title="Import a VS Code colour theme"
        >
          Import VS Code theme
        </button>
        {importWarning && <span className="appearance-import-warning">{importWarning}</span>}
      </span>
    </div>

    {/* Follow system theme toggle */}
    <label className="appearance-follow-row">
      <input
        type="checkbox"
        checked={followSystemTheme}
        onChange={(e) => onFollowSystemThemeChange(e.target.checked)}
      />
      <span>Follow system light/dark preference</span>
    </label>

    {followSystemTheme ? (
      /* Paired-theme selectors */
      <div className="appearance-pair-selectors">
        {[
          { label: '🌙 Dark theme', value: darkThemeName, onChange: onDarkThemeSelect },
          { label: '☀️ Light theme', value: lightThemeName, onChange: onLightThemeSelect },
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
                onClick={() => { onDarkThemeSelect(p.dark); onLightThemeSelect(p.light); }}
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
            onChange={(e) => onThemeSelect(e.target.value)}
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
            onClick={() => void onDuplicate()}
            title="Save a copy of this theme for editing"
          >
            Duplicate
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onReset}
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
                      onChange={(e) => onColorChange(key, e.target.value)}
                    />
                    <input
                      type="text"
                      className="appearance-color-hex"
                      value={value}
                      maxLength={7}
                      spellCheck={false}
                      onChange={(e) => onHexInput(key, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </>
    )}

    {/* ── Fonts section ── */}
    <div className="appearance-section-header">Fonts</div>
    <div className="appearance-editor-grid">
      <label htmlFor="ae-code-font">Code font</label>
      <select
        id="ae-code-font"
        className="appearance-editor-select"
        value={codeFont}
        onChange={(e) => onCodeFontChange(e.target.value)}
      >
        <option value="">Default</option>
        {monoFonts.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>

      <label htmlFor="ae-display-font">Display font</label>
      <select
        id="ae-display-font"
        className="appearance-editor-select"
        value={displayFont}
        onChange={(e) => onDisplayFontChange(e.target.value)}
      >
        <option value="">Default</option>
        {displayFonts.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
    </div>

    {/* ── Editor section ── */}
    <div className="appearance-section-header appearance-section-header--spaced">Editor</div>
    <div className="appearance-editor-grid">
      <label htmlFor="ae-font-size">Font size</label>
      <div className="appearance-editor-row">
        <input
          id="ae-font-size"
          type="number"
          className="appearance-editor-number"
          value={editorFontSize}
          min={8}
          max={32}
          onChange={(e) => onFontSizeChange(Number(e.target.value) || 13)}
        />
        <span className="appearance-editor-unit">px</span>
      </div>

      <label htmlFor="ae-tab-size">Tab size</label>
      <div className="appearance-editor-row">
        <input
          id="ae-tab-size"
          type="number"
          className="appearance-editor-number"
          value={editorTabSize}
          min={1}
          max={8}
          onChange={(e) => onTabSizeChange(Number(e.target.value) || 4)}
        />
        <span className="appearance-editor-unit">spaces</span>
      </div>

      <label htmlFor="ae-word-wrap">Word wrap</label>
      <label className="appearance-editor-check">
        <input
          id="ae-word-wrap"
          type="checkbox"
          checked={editorWordWrap}
          onChange={(e) => onWordWrapChange(e.target.checked)}
        />
        <span>Enabled</span>
      </label>
    </div>

    {/* ── Markdown section ── */}
    <div className="appearance-section-header appearance-section-header--spaced">Markdown</div>
    <div className="appearance-editor-grid">
      <label htmlFor="ae-read-max-width">Read-mode width</label>
      <div className="appearance-editor-row">
        <input
          id="ae-read-max-width"
          type="range"
          min={600}
          max={2000}
          step={50}
          value={readViewMaxWidth}
          onChange={(e) => onReadViewMaxWidthChange(Number(e.target.value))}
          className="appearance-editor-slider"
        />
        <span className="appearance-editor-unit">{readViewMaxWidth} px</span>
      </div>
    </div>
  </div>
  );
};
