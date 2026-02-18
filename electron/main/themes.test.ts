import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getThemesDir,
  ensureThemesDir,
  getThemePath,
  initializeThemes,
  loadTheme,
  listThemes,
  saveTheme,
  createCustomTheme,
  deleteTheme,
  type Theme,
  type ThemeColors,
} from './themes';

describe('Themes', () => {
  const themesDir = getThemesDir();

  afterEach(() => {
    // Clean up any test themes created
    try {
      const files = fs.readdirSync(themesDir);
      for (const file of files) {
        if (file.startsWith('test-') || file.startsWith('custom-')) {
          const filePath = path.join(themesDir, file);
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            // Ignore errors
          }
        }
      }
    } catch (err) {
      // Directory might not exist, ignore
    }
  });

  it('should return correct themes directory path', () => {
    const dir = getThemesDir();
    expect(dir).toContain('.PDV');
    expect(dir).toContain('themes');
  });

  it('should create themes directory if it does not exist', () => {
    ensureThemesDir();
    expect(fs.existsSync(themesDir)).toBe(true);
  });

  it('should initialize default themes', () => {
    initializeThemes();
    
    const darkThemePath = getThemePath('dark');
    const lightThemePath = getThemePath('light');
    
    expect(fs.existsSync(darkThemePath)).toBe(true);
    expect(fs.existsSync(lightThemePath)).toBe(true);
  });

  it('should load a theme', () => {
    initializeThemes();
    
    const theme = loadTheme('dark');
    expect(theme).not.toBeNull();
    expect(theme?.id).toBe('dark');
    expect(theme?.name).toBe('Dark (Default)');
    expect(theme?.colors.background).toBeDefined();
  });

  it('should return null for non-existent theme', () => {
    ensureThemesDir();
    const theme = loadTheme('non-existent');
    expect(theme).toBeNull();
  });

  it('should list all themes', () => {
    initializeThemes();
    
    const themes = listThemes();
    expect(themes.length).toBeGreaterThanOrEqual(3); // At least 3 default themes
    
    const themeIds = themes.map((t) => t.id);
    expect(themeIds).toContain('dark');
    expect(themeIds).toContain('light');
    expect(themeIds).toContain('high-contrast');
  });

  it('should save a custom theme', () => {
    ensureThemesDir();
    
    const customTheme: Theme = {
      id: 'test-save-custom',
      name: 'Test Custom',
      colors: {
        background: '#ff0000',
        foreground: '#00ff00',
      },
      isCustom: true,
    };
    
    saveTheme(customTheme);
    
    const loaded = loadTheme('test-save-custom');
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('test-save-custom');
    expect(loaded?.colors.background).toBe('#ff0000');
  });

  it('should create custom theme from base theme', () => {
    initializeThemes();
    
    const baseTheme = loadTheme('dark');
    expect(baseTheme).not.toBeNull();
    
    const customColors: ThemeColors = {
      background: '#ff0000',
      primary: '#00ff00',
    };
    
    const customTheme = createCustomTheme(baseTheme!, customColors);
    
    expect(customTheme.id).toMatch(/^custom-\d+$/);
    expect(customTheme.name).toContain('Custom');
    expect(customTheme.colors.background).toBe('#ff0000');
    expect(customTheme.colors.primary).toBe('#00ff00');
    // Should preserve other colors from base theme
    expect(customTheme.colors.foreground).toBe(baseTheme!.colors.foreground);
    expect(customTheme.isCustom).toBe(true);
  });

  it('should delete custom theme', () => {
    ensureThemesDir();
    
    const customTheme: Theme = {
      id: 'test-delete',
      name: 'Test Delete',
      colors: { background: '#000000' },
      isCustom: true,
    };
    
    saveTheme(customTheme);
    expect(fs.existsSync(getThemePath('test-delete'))).toBe(true);
    
    const deleted = deleteTheme('test-delete');
    expect(deleted).toBe(true);
    expect(fs.existsSync(getThemePath('test-delete'))).toBe(false);
  });

  it('should not delete default themes', () => {
    initializeThemes();
    
    const deleted = deleteTheme('dark');
    expect(deleted).toBe(false);
    expect(fs.existsSync(getThemePath('dark'))).toBe(true);
  });
});
