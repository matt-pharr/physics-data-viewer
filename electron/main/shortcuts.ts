import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Keyboard shortcut definition
 */
export interface KeyboardShortcut {
  action: string;
  key: string;
  modifiers?: string[];
}

/**
 * Get the shortcuts directory path (~/.PDV/shortcuts)
 */
export function getShortcutsDir(): string {
  return path.join(os.homedir(), '.PDV', 'shortcuts');
}

/**
 * Get the shortcuts file path (~/.PDV/shortcuts/config.json)
 */
export function getShortcutsPath(): string {
  return path.join(getShortcutsDir(), 'config.json');
}

/**
 * Ensure the shortcuts directory exists
 */
export function ensureShortcutsDir(): void {
  const dir = getShortcutsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[shortcuts] Created shortcuts directory at:', dir);
  }
}

/**
 * Default keyboard shortcuts
 */
const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  { action: 'Execute Code', key: 'Enter', modifiers: ['Shift'] },
  { action: 'Clear Console', key: 'K', modifiers: ['CommandOrControl'] },
  { action: 'New Tab', key: 'T', modifiers: ['CommandOrControl'] },
  { action: 'Close Tab', key: 'W', modifiers: ['CommandOrControl'] },
  { action: 'Next Tab', key: 'Tab', modifiers: ['Control'] },
  { action: 'Previous Tab', key: 'Tab', modifiers: ['Control', 'Shift'] },
  { action: 'Toggle Console', key: '`', modifiers: ['CommandOrControl'] },
  { action: 'Open Settings', key: ',', modifiers: ['CommandOrControl'] },
];

/**
 * Load keyboard shortcuts from ~/.PDV/shortcuts/config.json
 */
export function loadShortcuts(): KeyboardShortcut[] {
  ensureShortcutsDir();
  const shortcutsPath = getShortcutsPath();
  
  try {
    if (fs.existsSync(shortcutsPath)) {
      const data = fs.readFileSync(shortcutsPath, 'utf-8');
      const shortcuts = JSON.parse(data) as KeyboardShortcut[];
      console.log('[shortcuts] Loaded shortcuts from:', shortcutsPath);
      return shortcuts;
    }
  } catch (error) {
    console.error('[shortcuts] Failed to load shortcuts:', error);
  }
  
  // Return default shortcuts if file doesn't exist or fails to load
  console.log('[shortcuts] Using default shortcuts');
  return DEFAULT_SHORTCUTS;
}

/**
 * Save keyboard shortcuts to ~/.PDV/shortcuts/config.json
 */
export function saveShortcuts(shortcuts: KeyboardShortcut[]): void {
  ensureShortcutsDir();
  const shortcutsPath = getShortcutsPath();
  
  try {
    fs.writeFileSync(shortcutsPath, JSON.stringify(shortcuts, null, 2), 'utf-8');
    console.log('[shortcuts] Saved shortcuts to:', shortcutsPath);
  } catch (error) {
    console.error('[shortcuts] Failed to save shortcuts:', error);
    throw error;
  }
}

/**
 * Reset shortcuts to defaults
 */
export function resetShortcuts(): KeyboardShortcut[] {
  saveShortcuts(DEFAULT_SHORTCUTS);
  return DEFAULT_SHORTCUTS;
}
