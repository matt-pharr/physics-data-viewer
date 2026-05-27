/**
 * utils.ts — pure shortcut utility helpers used by SettingsDialog.
 */

import type { LauncherCheck, TerminalPreset } from '../../types';

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
    // A deliberately small macOS set covering the common terminals; Alacritty
    // and WezTerm remain available via "Custom…" (and their templates are kept
    // for Linux and any already-saved config).
    return ['terminal-app', 'iterm2', 'kitty', 'ghostty', 'custom', 'none'];
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

// ---------------------------------------------------------------------------
// Launcher preset catalogs (editor / IDE and file manager)
//
// Each preset carries the command template (`{}` is the path placeholder)
// and a `check` describing how `launchers.checkAvailability` should verify
// it is installed. `'custom'` is rendered as a dropdown option but is not in
// these arrays — the UI shows a free-text field for it.
// ---------------------------------------------------------------------------

/** Sentinel preset id for the "Custom…" dropdown option. */
export const CUSTOM_PRESET_ID = 'custom';

/** An editor/IDE the user can pick from the General-tab dropdown. */
export interface EditorPreset {
  id: string;
  label: string;
  /** Command template with `{}` path placeholder. */
  command: string;
  /** Whether this editor must be wrapped in a terminal (vim, nano, …). */
  isTuiEditor: boolean;
  check: LauncherCheck;
}

/**
 * Editor/IDE presets. All are cross-platform tools; the dropdown shows the
 * same set on every platform (availability checking weeds out uninstalled
 * ones). The single chosen command drives both file-open and folder-open.
 */
export const EDITOR_PRESETS: readonly EditorPreset[] = [
  { id: 'vscode',  label: 'VS Code',      command: 'code {}',  isTuiEditor: false, check: { kind: 'path', bin: 'code' } },
  { id: 'cursor',  label: 'Cursor',       command: 'cursor {}', isTuiEditor: false, check: { kind: 'path', bin: 'cursor' } },
  { id: 'sublime', label: 'Sublime Text', command: 'subl {}',  isTuiEditor: false, check: { kind: 'path', bin: 'subl' } },
  { id: 'zed',     label: 'Zed',          command: 'zed {}',   isTuiEditor: false, check: { kind: 'path', bin: 'zed' } },
  { id: 'vim',     label: 'Vim',          command: 'vim {}',   isTuiEditor: true,  check: { kind: 'path', bin: 'vim' } },
  { id: 'nvim',    label: 'Neovim',       command: 'nvim {}',  isTuiEditor: true,  check: { kind: 'path', bin: 'nvim' } },
  { id: 'emacs',   label: 'Emacs',        command: 'emacs {}', isTuiEditor: false, check: { kind: 'path', bin: 'emacs' } },
  { id: 'nano',    label: 'Nano',         command: 'nano {}',  isTuiEditor: true,  check: { kind: 'path', bin: 'nano' } },
];

/**
 * Derive a {@link LauncherCheck} from an arbitrary command string (used for
 * the "Custom…" option). Probes the first token on `$PATH`; an empty command
 * is treated as always-available so a blank custom field doesn't block Save.
 *
 * Limitation: the first token is assumed to be the executable, so a wrapper
 * or env prefix (`env FOO=1 code {}`, `flatpak run org.x {}`) checks the
 * wrapper (`env` / `flatpak`) rather than the real program. The worst case is
 * a spurious "not found" marker on an otherwise-valid custom command.
 *
 * @param command - Command template, e.g. `"alacritty -e {cmd}"`.
 * @returns A check descriptor.
 */
export function checkForCommand(command: string): LauncherCheck {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return first ? { kind: 'path', bin: first } : { kind: 'none' };
}

/**
 * Reverse-map a saved editor command to a preset id, or {@link CUSTOM_PRESET_ID}
 * when it matches no preset.
 *
 * @param command - The saved `launchers.editor.fileCommand`.
 * @returns A preset id.
 */
export function editorPresetIdForCommand(command: string | undefined): string {
  const norm = (command ?? '').trim();
  return EDITOR_PRESETS.find((p) => p.command === norm)?.id ?? CUSTOM_PRESET_ID;
}

/**
 * The {@link LauncherCheck} for a terminal preset on a given platform.
 * macOS GUI terminals are `.app` bundles; their Linux builds are CLI
 * binaries. `'custom'` derives its check from the user's template.
 *
 * @param preset - Terminal preset id.
 * @param platform - NodeJS platform identifier.
 * @param customTemplate - The custom template, when `preset === 'custom'`.
 * @returns A check descriptor.
 */
export function terminalPresetCheck(
  preset: TerminalPreset,
  platform: NodeJS.Platform,
  customTemplate?: string,
): LauncherCheck {
  const macApp = (app: string, bin: string): LauncherCheck =>
    platform === 'darwin' ? { kind: 'macapp', app } : { kind: 'path', bin };
  switch (preset) {
    case 'none':
    case 'terminal-app':
      return { kind: 'none' };
    case 'iterm2':
      return { kind: 'macapp', app: 'iTerm' };
    case 'ghostty':
      return macApp('Ghostty', 'ghostty');
    case 'kitty':
      return macApp('kitty', 'kitty');
    case 'alacritty':
      return macApp('Alacritty', 'alacritty');
    case 'wezterm':
      return macApp('WezTerm', 'wezterm');
    case 'gnome-terminal':
      return { kind: 'path', bin: 'gnome-terminal' };
    case 'konsole':
      return { kind: 'path', bin: 'konsole' };
    case 'xterm':
      return { kind: 'path', bin: 'xterm' };
    case 'x-terminal-emulator':
      return { kind: 'path', bin: 'x-terminal-emulator' };
    case 'windows-terminal':
      return { kind: 'path', bin: 'wt.exe' };
    case 'custom':
      return checkForCommand(customTemplate ?? '');
  }
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
