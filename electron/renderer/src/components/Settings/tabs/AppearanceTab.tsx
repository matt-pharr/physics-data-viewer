import React, { useState, useEffect } from 'react';
import type { Theme, ThemeColors } from '../../../../main/ipc';

interface AppearanceTabProps {
  currentThemeId?: string;
  customColors?: ThemeColors;
  customThemeName?: string;
  onThemeSelect: (themeId: string) => void;
  onColorsChange: (colors: ThemeColors) => void;
  onThemeNameChange: (name: string) => void;
}

const DEFAULT_COLOR = '#000000';

export const AppearanceTab: React.FC<AppearanceTabProps> = ({
  currentThemeId,
  customColors,
  customThemeName,
  onThemeSelect,
  onColorsChange,
  onThemeNameChange,
}) => {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [selectedTheme, setSelectedTheme] = useState<Theme | null>(null);
  const [colors, setColors] = useState<ThemeColors>({});
  const [themeName, setThemeName] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadThemes();
  }, []);

  useEffect(() => {
    // When currentThemeId or customColors change, update the local state
    if (currentThemeId && themes.length > 0) {
      const theme = themes.find((t) => t.id === currentThemeId);
      if (theme) {
        setSelectedTheme(theme);
        setColors(customColors || theme.colors);
        setThemeName(customThemeName || theme.name);
        setHasChanges(false);
      }
    }
  }, [currentThemeId, customColors, customThemeName, themes]);

  const loadThemes = async () => {
    try {
      const loadedThemes = await window.pdv.themes.list();
      setThemes(loadedThemes);
      
      if (currentThemeId) {
        const theme = loadedThemes.find((t) => t.id === currentThemeId);
        if (theme) {
          setSelectedTheme(theme);
          setColors(customColors || theme.colors);
          setThemeName(customThemeName || theme.name);
        }
      } else if (loadedThemes.length > 0) {
        // Default to first theme (dark)
        setSelectedTheme(loadedThemes[0]);
        setColors(loadedThemes[0].colors);
        setThemeName(loadedThemes[0].name);
      }
    } catch (error) {
      console.error('[AppearanceTab] Failed to load themes:', error);
    }
  };

  const handleThemeSelectChange = (themeId: string) => {
    const theme = themes.find((t) => t.id === themeId);
    if (theme) {
      setSelectedTheme(theme);
      setColors(theme.colors);
      setThemeName(theme.name);
      setHasChanges(false);
      // Notify parent that a different theme was selected
      onThemeSelect(theme.id);
      onColorsChange(theme.colors);
      onThemeNameChange(theme.name);
    }
  };

  const handleColorChange = (colorKey: string, value: string) => {
    const updatedColors = { ...colors, [colorKey]: value };
    setColors(updatedColors);
    setHasChanges(true);
    // Notify parent of color changes, but don't create theme yet
    onColorsChange(updatedColors);
  };

  const handleThemeNameChange = (name: string) => {
    setThemeName(name);
    setHasChanges(true);
    // Notify parent of name change
    onThemeNameChange(name);
  };

  const colorFields: Array<{ key: keyof ThemeColors; label: string }> = [
    { key: 'background', label: 'Background' },
    { key: 'foreground', label: 'Foreground' },
    { key: 'primary', label: 'Primary' },
    { key: 'secondary', label: 'Secondary' },
    { key: 'accent', label: 'Accent' },
    { key: 'border', label: 'Border' },
    { key: 'error', label: 'Error' },
    { key: 'success', label: 'Success' },
    { key: 'warning', label: 'Warning' },
  ];

  return (
    <>
      <div className="settings-section">
        <h3>Theme</h3>
        
        <div className="settings-field">
          <label htmlFor="theme">Select Theme</label>
          <select
            id="theme"
            value={selectedTheme?.id || ''}
            onChange={(e) => handleThemeSelectChange(e.target.value)}
            className="settings-select"
          >
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label htmlFor="themeName">Theme Name</label>
          <input
            id="themeName"
            type="text"
            value={themeName}
            onChange={(e) => handleThemeNameChange(e.target.value)}
            placeholder="Enter theme name"
            className="settings-input"
          />
          {hasChanges && (
            <div className="settings-hint">
              Theme changes will be saved when you click "Save" at the bottom of the settings dialog.
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h3>Colors</h3>
        
        <div className="settings-color-grid">
          {colorFields.map(({ key, label }) => (
            <div key={key} className="settings-color-field">
              <label htmlFor={`color-${key}`}>{label}</label>
              <div className="settings-color-input-row">
                <input
                  id={`color-${key}`}
                  type="color"
                  value={colors[key] || DEFAULT_COLOR}
                  onChange={(e) => handleColorChange(key, e.target.value)}
                  className="settings-color-picker"
                />
                <input
                  type="text"
                  value={colors[key] || ''}
                  onChange={(e) => handleColorChange(key, e.target.value)}
                  placeholder="#000000"
                  className="settings-color-text"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
