/**
 * utils.ts — pure shortcut utility helpers used by SettingsDialog.
 */

import type { TerminalPreset } from '../../types';

/** Runtime platform check used for shortcut labels and default commands. */
export const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().startsWith('MAC');

/**
 * Human-readable labels for each terminal preset shown in the General tab's
 * "Terminal application" dropdown.
 *
 * The keys are typed as {@link TerminalPreset} so a new preset added in
 * `electron/main/editor-spawn.ts` (the source-of-truth list) will fail
 * typecheck here until a label is added — keeping the renderer in sync with
 * the main-side preset table.
 */
export const TERMINAL_PRESET_LABELS: Record<TerminalPreset, string> = {
  'terminal-app': 'Terminal.app',
  'iterm2': 'iTerm2',
  'ghostty': 'Ghostty',
  'alacritty': 'Alacritty',
  'kitty': 'kitty',
  'wezterm': 'WezTerm',
  'gnome-terminal': 'GNOME Terminal',
  'konsole': 'Konsole',
  'xterm': 'xterm',
  'x-terminal-emulator': 'System default (x-terminal-emulator)',
  'windows-terminal': 'Windows Terminal',
  'custom': 'Custom…',
  'none': 'None (no terminal wrap)',
};

/**
 * Presets surfaced in the dropdown for a given platform, in display order.
 * Mirrors `getTerminalPresetsForPlatform` in `main/editor-spawn.ts`; kept
 * in lockstep via the {@link TERMINAL_PRESET_LABELS} type check above.
 *
 * @param platform - NodeJS platform identifier from `window.pdv.system.platform`.
 * @returns Preset keys to render in the dropdown.
 */
export function getTerminalPresetsForPlatform(platform: NodeJS.Platform): TerminalPreset[] {
  if (platform === 'darwin') {
    return ['terminal-app', 'iterm2', 'ghostty', 'alacritty', 'kitty', 'wezterm', 'custom', 'none'];
  }
  if (platform === 'win32') {
    return ['windows-terminal', 'custom', 'none'];
  }
  return [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xterm',
    'alacritty',
    'kitty',
    'wezterm',
    'ghostty',
    'custom',
    'none',
  ];
}

/**
 * Default preset for a given platform, matching `defaultTerminalPreset` in
 * `main/editor-spawn.ts`. Used as the prefilled selection in the dropdown
 * when the user hasn't yet saved a preference.
 */
export function defaultTerminalPresetForPlatform(platform: NodeJS.Platform): TerminalPreset {
  if (platform === 'darwin') return 'terminal-app';
  if (platform === 'win32') return 'windows-terminal';
  return 'x-terminal-emulator';
}

/**
 * TUI editor basenames PDV auto-wraps in a terminal. Mirrors `TERMINAL_EDITORS`
 * in `main/editor-spawn.ts` — kept in sync manually (the list is small and
 * stable, and the runtime value can't cross the process boundary).
 */
const TUI_EDITOR_BASENAMES = new Set([
  'vi', 'vim', 'nvim', 'nano', 'pico', 'emacs', 'kak', 'hx', 'helix',
]);

/**
 * Whether an editor command's executable looks like a TUI editor. Used to
 * pre-derive the "Run in terminal" checkbox so vim/nvim work without the
 * user having to discover the setting. Mirrors `isTerminalEditorCommand`
 * in `main/editor-spawn.ts`.
 *
 * @param command - Editor command template, e.g. `"nvim {}"` or `"code {}"`.
 * @returns True when the first token's basename is a known TUI editor.
 */
export function isLikelyTuiEditor(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  const base = (firstToken.split(/[/\\]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  return TUI_EDITOR_BASENAMES.has(base);
}

/** Convert a stored shortcut token to a human-readable key badge label. */
export function tokenToLabel(token: string): string {
  switch (token.toLowerCase()) {
    case 'commandorcontrol': return IS_MAC ? '⌘' : 'Ctrl';
    case 'command': case 'cmd': case 'meta': return '⌘';
    case 'control': case 'ctrl': return 'Ctrl';
    case 'shift': return '⇧';
    case 'alt': case 'option': return IS_MAC ? '⌥' : 'Alt';
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
export function parseShortcutTokens(shortcut: string): string[] {
  return shortcut
    .replace(/\s+/g, '')
    .split('+')
    .filter(Boolean)
    .map(tokenToLabel);
}

/** Build a stored shortcut string from a KeyboardEvent. Returns '' if only modifiers. */
export function buildShortcutString(e: KeyboardEvent): string {
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
export function normalizeShortcut(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}
