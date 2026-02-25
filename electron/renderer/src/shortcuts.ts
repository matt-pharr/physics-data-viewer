/**
 * Central registry for all PDV keyboard shortcuts.
 *
 * Components read shortcuts from this module (defaults) or from the resolved
 * value that App derives from config.settings.shortcuts. Nothing outside this
 * file should hardcode shortcut strings or define matchesShortcut.
 */

export interface Shortcuts {
  /** Open the Settings dialog. */
  openSettings: string;
  /** Execute the active code-cell tab. */
  execute: string;
  /** Add a new code-cell tab. */
  newTab: string;
  /** Close the active code-cell tab. */
  closeTab: string;
  /** Close the application window. */
  closeWindow: string;
  /** Copy the focused tree node's dot path to the clipboard. */
  treeCopyPath: string;
  /** Open the focused script node in an external editor. */
  treeEditScript: string;
  /** Print the focused tree node in the console. */
  treePrint: string;
}

/** Default shortcut bindings applied when user has no overrides. */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  openSettings: 'CommandOrControl+,',
  execute: 'CommandOrControl+Enter',
  newTab: 'CommandOrControl+T',
  closeTab: 'CommandOrControl+W',
  closeWindow: 'CommandOrControl+Shift+W',
  treeCopyPath: 'CommandOrControl+C',
  treeEditScript: 'E',
  treePrint: 'P',
};

/** Human-readable labels shown in the Settings → Keyboard Shortcuts tab. */
export const SHORTCUT_LABELS: Record<keyof Shortcuts, string> = {
  openSettings: 'Open Settings',
  execute: 'Execute Code',
  newTab: 'New Command Tab',
  closeTab: 'Close Command Tab',
  closeWindow: 'Close Window',
  treeCopyPath: 'Copy Node Path',
  treeEditScript: 'Edit Script',
  treePrint: 'Print Node',
};

/**
 * Merge persisted shortcut overrides on top of the defaults.
 * Any key absent from `saved` falls back to its default value.
 */
export function resolveShortcuts(saved: Partial<Shortcuts> | undefined): Shortcuts {
  return { ...DEFAULT_SHORTCUTS, ...saved };
}

/**
 * Format a shortcut string into a compact human-readable hint for use in
 * context menus, e.g. "CommandOrControl+C" → "⌘C", "E" → "E".
 */
export function formatShortcutHint(shortcut: string): string {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().startsWith('MAC');
  return shortcut
    .replace(/\s+/g, '')
    .split('+')
    .map((token) => {
      switch (token.toLowerCase()) {
        case 'commandorcontrol': return isMac ? '⌘' : 'Ctrl+';
        case 'command': case 'cmd': case 'meta': return '⌘';
        case 'control': case 'ctrl': return 'Ctrl+';
        case 'shift': return '⇧';
        case 'alt': case 'option': return isMac ? '⌥' : 'Alt+';
        case 'enter': return '↵';
        case 'comma': return ',';
        default: return token.toUpperCase();
      }
    })
    .join('');
}

/**
 * Returns true when the keyboard event matches a shortcut string such as
 * "CommandOrControl+Enter", "E", or "CommandOrControl+,".
 *
 * Modifier tokens (case-insensitive, order-independent):
 *   commandorcontrol  → metaKey || ctrlKey
 *   command / cmd / meta → metaKey
 *   control / ctrl → ctrlKey
 *   alt / option → altKey
 *   shift → shiftKey
 *
 * The key token is compared against event.key (lowercased). The special token
 * "comma" maps to "," so that "CommandOrControl+," can be written unambiguously.
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  const keyPart = parts.pop();
  if (!keyPart) return false;
  const normalizedKey = keyPart === 'comma' ? ',' : keyPart;
  if (event.key.toLowerCase() !== normalizedKey) return false;
  return parts.every((part) => {
    if (part === 'commandorcontrol') return event.metaKey || event.ctrlKey;
    if (part === 'command' || part === 'cmd' || part === 'meta') return event.metaKey;
    if (part === 'control' || part === 'ctrl') return event.ctrlKey;
    if (part === 'alt' || part === 'option') return event.altKey;
    if (part === 'shift') return event.shiftKey;
    return false;
  });
}
