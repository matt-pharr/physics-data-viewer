import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Settings stored in ~/.PDV/settings
 */
export interface Settings {
  pythonPath?: string;
  juliaPath?: string;
  editors?: {
    python?: string;
    julia?: string;
    default?: string;
  };
  treeRoot?: string;
  theme?: 'dark' | 'light';
}

/**
 * Get the settings directory path (~/.PDV/settings)
 */
export function getSettingsDir(): string {
  return path.join(os.homedir(), '.PDV', 'settings');
}

/**
 * Get the settings file path (~/.PDV/settings/config.json)
 */
export function getSettingsPath(): string {
  return path.join(getSettingsDir(), 'config.json');
}

/**
 * Ensure the settings directory exists
 */
export function ensureSettingsDir(): void {
  const dir = getSettingsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[settings] Created settings directory at:', dir);
  }
}

/**
 * Load settings from ~/.PDV/settings/config.json
 */
export function loadSettings(): Settings {
  ensureSettingsDir();
  const settingsPath = getSettingsPath();
  
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(data) as Settings;
    }
  } catch (error) {
    console.error('[settings] Failed to load settings:', error);
  }
  
  return {};
}

/**
 * Save settings to ~/.PDV/settings/config.json
 */
export function saveSettings(settings: Settings): void {
  ensureSettingsDir();
  const settingsPath = getSettingsPath();
  
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    console.log('[settings] Saved settings to:', settingsPath);
  } catch (error) {
    console.error('[settings] Failed to save settings:', error);
    throw error;
  }
}

/**
 * Update settings (merge with existing)
 */
export function updateSettings(partial: Partial<Settings>): Settings {
  const current = loadSettings();
  const updated = { ...current, ...partial };
  saveSettings(updated);
  return updated;
}
