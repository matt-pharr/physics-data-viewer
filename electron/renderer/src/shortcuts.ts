/**
 * Central registry for user-customizable keyboard shortcuts.
 *
 * PDV has two kinds of keyboard shortcuts:
 *
 * 1. **Fixed menu accelerators** — Shortcuts for actions that appear in the
 *    native app menu (File > Open, Save, Settings, Close Window, etc.). These
 *    are defined as Electron `accelerator` strings in `menu.ts` and are NOT
 *    user-customizable. They follow platform conventions (Cmd+S, Cmd+O, Cmd+,)
 *    and the menu always displays the correct hint.
 *
 * 2. **Customizable shortcuts** (this file) — Shortcuts for actions that do NOT
 *    appear in the native menu: code cell operations, tree actions, etc. These
 *    are handled by the renderer via `useKeyboardShortcuts` and
 *    `matchesShortcut()`. Users can rebind them in Settings > Keyboard Shortcuts.
 *
 * 3. **Monaco editor shortcuts** — Monaco intercepts keyboard events before they
 *    reach the document-level listener. Customizable shortcuts that must work
 *    while the code editor is focused (execute, new tab, close tab, tab
 *    switching) are duplicated in `CodeCell`'s `editor.onKeyDown` handler using
 *    `matchesShortcut()` on the native browser event. This ensures they respond
 *    to user-customized bindings even when Monaco has focus.
 *
 * 4. **Tree panel shortcuts** — The Tree component has its own `onKeyDown`
 *    handler that listens for tree-specific shortcuts (Copy Path, Edit Script,
 *    Print Node) when the tree panel is focused. These are single-key or
 *    modifier shortcuts (e.g. `E`, `P`, `Cmd+C`) that only fire when the tree
 *    has focus, avoiding conflicts with the code editor.
 *
 * This separation exists because Electron's native menu accelerators cannot be
 * updated at runtime. If a shortcut appears in a menu, it must be fixed so the
 * displayed hint stays accurate.
 */

export interface Shortcuts {
  /** Execute the active code-cell tab. */
  execute: string;
  /** Add a new code-cell tab. */
  newTab: string;
  /** Close the active code-cell tab. */
  closeTab: string;
  /** Copy the focused tree node's dot path to the clipboard. */
  treeCopyPath: string;
  /** Open the focused script node in an external editor. */
  treeEditScript: string;
  /** Print the focused tree node in the console. */
  treePrint: string;
}

/** Default shortcut bindings applied when user has no overrides. */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  execute: 'CommandOrControl+Enter',
  newTab: 'CommandOrControl+T',
  closeTab: 'CommandOrControl+W',
  treeCopyPath: 'CommandOrControl+C',
  treeEditScript: 'E',
  treePrint: 'P',
};

/** Human-readable labels shown in the Settings → Keyboard Shortcuts tab. */
export const SHORTCUT_LABELS: Record<keyof Shortcuts, string> = {
  execute: 'Execute Code',
  newTab: 'New Command Tab',
  closeTab: 'Close Command Tab',
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
