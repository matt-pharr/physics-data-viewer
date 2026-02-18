import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Theme color definition
 */
export interface ThemeColors {
  background?: string;
  foreground?: string;
  primary?: string;
  secondary?: string;
  accent?: string;
  border?: string;
  error?: string;
  success?: string;
  warning?: string;
  [key: string]: string | undefined;
}

/**
 * Complete theme definition
 */
export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
  isCustom?: boolean;
}

/**
 * Get the themes directory path (~/.PDV/themes)
 */
export function getThemesDir(): string {
  return path.join(os.homedir(), '.PDV', 'themes');
}

/**
 * Ensure the themes directory exists
 */
export function ensureThemesDir(): void {
  const dir = getThemesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[themes] Created themes directory at:', dir);
  }
}

/**
 * Get path to a specific theme file
 */
export function getThemePath(themeId: string): string {
  return path.join(getThemesDir(), `${themeId}.json`);
}

/**
 * Default themes
 */
const DEFAULT_THEMES: Theme[] = [
  {
    id: 'dark',
    name: 'Dark (Default)',
    colors: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      primary: '#007acc',
      secondary: '#3c3c3c',
      accent: '#0e639c',
      border: '#3c3c3c',
      error: '#f48771',
      success: '#89d185',
      warning: '#f6c177',
    },
  },
  {
    id: 'light',
    name: 'Light',
    colors: {
      background: '#ffffff',
      foreground: '#333333',
      primary: '#0066cc',
      secondary: '#e0e0e0',
      accent: '#0052a3',
      border: '#cccccc',
      error: '#d9534f',
      success: '#5cb85c',
      warning: '#f0ad4e',
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    colors: {
      background: '#000000',
      foreground: '#ffffff',
      primary: '#00ffff',
      secondary: '#444444',
      accent: '#00cccc',
      border: '#ffffff',
      error: '#ff0000',
      success: '#00ff00',
      warning: '#ffff00',
    },
  },
];

/**
 * Initialize themes directory with default themes
 */
export function initializeThemes(): void {
  ensureThemesDir();
  
  for (const theme of DEFAULT_THEMES) {
    const themePath = getThemePath(theme.id);
    if (!fs.existsSync(themePath)) {
      try {
        fs.writeFileSync(themePath, JSON.stringify(theme, null, 2), 'utf-8');
        console.log('[themes] Created default theme:', theme.id);
      } catch (error) {
        console.error('[themes] Failed to create default theme:', theme.id, error);
      }
    }
  }
}

/**
 * Load a specific theme by ID
 */
export function loadTheme(themeId: string): Theme | null {
  ensureThemesDir();
  const themePath = getThemePath(themeId);
  
  try {
    if (fs.existsSync(themePath)) {
      const data = fs.readFileSync(themePath, 'utf-8');
      return JSON.parse(data) as Theme;
    }
  } catch (error) {
    console.error('[themes] Failed to load theme:', themeId, error);
  }
  
  return null;
}

/**
 * List all available themes
 */
export function listThemes(): Theme[] {
  ensureThemesDir();
  initializeThemes(); // Ensure default themes exist
  
  const themes: Theme[] = [];
  const themesDir = getThemesDir();
  
  try {
    const files = fs.readdirSync(themesDir);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const themeId = file.replace('.json', '');
        const theme = loadTheme(themeId);
        if (theme) {
          themes.push(theme);
        }
      }
    }
  } catch (error) {
    console.error('[themes] Failed to list themes:', error);
  }
  
  return themes;
}

/**
 * Save a theme
 */
export function saveTheme(theme: Theme): void {
  ensureThemesDir();
  const themePath = getThemePath(theme.id);
  
  try {
    fs.writeFileSync(themePath, JSON.stringify(theme, null, 2), 'utf-8');
    console.log('[themes] Saved theme:', theme.id);
  } catch (error) {
    console.error('[themes] Failed to save theme:', theme.id, error);
    throw error;
  }
}

/**
 * Create a custom theme based on an existing theme
 */
export function createCustomTheme(baseTheme: Theme, customColors: ThemeColors): Theme {
  const timestamp = Date.now();
  const customTheme: Theme = {
    id: `custom-${timestamp}`,
    name: `Custom (${baseTheme.name})`,
    colors: { ...baseTheme.colors, ...customColors },
    isCustom: true,
  };
  
  saveTheme(customTheme);
  return customTheme;
}

/**
 * Delete a custom theme
 */
export function deleteTheme(themeId: string): boolean {
  // Prevent deletion of default themes
  if (DEFAULT_THEMES.some((t) => t.id === themeId)) {
    console.warn('[themes] Cannot delete default theme:', themeId);
    return false;
  }
  
  const themePath = getThemePath(themeId);
  
  try {
    if (fs.existsSync(themePath)) {
      fs.unlinkSync(themePath);
      console.log('[themes] Deleted theme:', themeId);
      return true;
    }
  } catch (error) {
    console.error('[themes] Failed to delete theme:', themeId, error);
  }
  
  return false;
}
