/**
 * Built-in themes and colour-variable metadata for the Appearance settings tab.
 *
 * Built-in themes are never written to the main-process `savedThemes` store.
 * Custom themes saved by the user are stored there and merged at display time.
 */

import type { Theme } from './types';

/** Ordered group definitions for the colour editor. */
export const CSS_VAR_GROUPS: { label: string; vars: { key: string; label: string }[] }[] = [
  {
    label: 'Backgrounds',
    vars: [
      { key: 'bg-primary',   label: 'Primary' },
      { key: 'bg-secondary', label: 'Secondary' },
      { key: 'bg-tertiary',  label: 'Tertiary' },
      { key: 'bg-hover',     label: 'Hover' },
    ],
  },
  {
    label: 'Text',
    vars: [
      { key: 'text-primary',   label: 'Primary' },
      { key: 'text-secondary', label: 'Secondary' },
      { key: 'text-hint',      label: 'Hint' },
    ],
  },
  {
    label: 'Accents & Borders',
    vars: [
      { key: 'accent',       label: 'Accent' },
      { key: 'accent-hover', label: 'Accent Hover' },
      { key: 'border-color', label: 'Border' },
      { key: 'error',        label: 'Error' },
      { key: 'warning',      label: 'Warning' },
      { key: 'warning-hover',label: 'Warning Hover' },
      { key: 'success',      label: 'Success' },
    ],
  },
];

/** Built-in PDV theme entry with mapped Monaco theme id. */
interface BuiltinTheme extends Theme {
  /** Monaco editor theme identifier. */
  monacoTheme: string;
}

/** Built-in theme catalogue shown in Appearance settings. */
export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    name: 'Dark+ (VSCode)',
    monacoTheme: 'vs-dark',
    colors: {
      'bg-primary':   '#1e1e1e',
      'bg-secondary': '#252526',
      'bg-tertiary':  '#2d2d30',
      'bg-hover':     '#2a2d2e',
      'text-primary':   '#d4d4d4',
      'text-secondary': '#858585',
      'text-hint':      '#5a5a5a',
      'accent':       '#007acc',
      'accent-hover': '#1a8fd1',
      'border-color': '#474747',
      'error':        '#f48771',
      'warning':      '#dcdcaa',
      'warning-hover':'#e4e4b4',
      'success':      '#4ec9b0',
    },
  },
  {
    name: 'Light+ (VSCode)',
    monacoTheme: 'vs',
    colors: {
      'bg-primary':   '#ffffff',
      'bg-secondary': '#f3f3f3',
      'bg-tertiary':  '#ebebeb',
      'bg-hover':     '#e8e8e8',
      'text-primary':   '#383838',
      'text-secondary': '#717171',
      'text-hint':      '#aaaaaa',
      'accent':       '#007acc',
      'accent-hover': '#005a9e',
      'border-color': '#d4d4d4',
      'error':        '#e51400',
      'warning':      '#bf8803',
      'warning-hover':'#a67702',
      'success':      '#16825d',
    },
  },
  {
    name: 'Monokai',
    monacoTheme: 'pdv-monokai',
    colors: {
      'bg-primary':   '#272822',
      'bg-secondary': '#1e1f1c',
      'bg-tertiary':  '#33342e',
      'bg-hover':     '#3e3f38',
      'text-primary':   '#f8f8f2',
      'text-secondary': '#75715e',
      'text-hint':      '#49483e',
      'accent':       '#a6e22e',
      'accent-hover': '#b8f040',
      'border-color': '#49483e',
      'error':        '#f92672',
      'warning':      '#e6db74',
      'warning-hover':'#f0e68c',
      'success':      '#a6e22e',
    },
  },
  {
    name: 'Xcode Light',
    monacoTheme: 'pdv-xcode-light',
    colors: {
      'bg-primary':   '#ffffff',
      'bg-secondary': '#f5f5f5',
      'bg-tertiary':  '#c9c9c9',
      'bg-hover':     '#dedcde',
      'text-primary':   '#000000',
      'text-secondary': '#444444',
      'text-hint':      '#bbbbbb',
      'accent':       '#128cff',
      'accent-hover': '#0a70cc',
      'border-color': '#d9d6d7',
      'error':        '#ff0000',
      'warning':      '#996800',
      'warning-hover':'#7a5300',
      'success':      '#008e00',
    },
  },
  {
    name: 'Xcode Dark',
    monacoTheme: 'pdv-xcode-dark',
    colors: {
      'bg-primary':   '#242529',
      'bg-secondary': '#303136',
      'bg-tertiary':  '#414045',
      'bg-hover':     '#403f44',
      'text-primary':   '#ffffff',
      'text-secondary': '#a0a0a0',
      'text-hint':      '#6c6b70',
      'accent':       '#1780fa',
      'accent-hover': '#0a64ca',
      'border-color': '#1a191c',
      'error':        '#f44747',
      'warning':      '#ffd60a',
      'warning-hover':'#ffe54c',
      'success':      '#32d74b',
    },
  },
];

/** Fast lookup set for distinguishing built-in vs custom theme names. */
export const BUILTIN_THEME_NAMES = new Set(BUILTIN_THEMES.map((t) => t.name));

/**
 * A named pairing that associates a dark and light variant of the same theme family.
 * Used to enable automatic switching based on `prefers-color-scheme`.
 */
interface ThemePair {
  /** Human-readable name for the pair (shown in settings). */
  name: string;
  dark: string;
  light: string;
}

/** Named dark/light pairings used for follow-system-theme mode. */
export const THEME_PAIRS: ThemePair[] = [
  { name: 'VSCode', dark: 'Dark+ (VSCode)', light: 'Light+ (VSCode)' },
  { name: 'Xcode',  dark: 'Xcode Dark',     light: 'Xcode Light'     },
];

/**
 * Look up the color map for a named theme from the built-ins or saved custom themes.
 * Returns undefined if the name is not found.
 */
export function resolveThemeColors(
  name: string | undefined,
  savedThemes: Theme[],
): Record<string, string> | undefined {
  if (!name) return undefined;
  const all = [...BUILTIN_THEMES, ...savedThemes];
  return all.find((t) => t.name === name)?.colors;
}

/**
 * Register custom Monaco editor themes. Call this in the Editor's `beforeMount` prop.
 * Built-in Monaco themes (`vs`, `vs-dark`, `hc-black`) do not need registration.
 */
export function defineMonacoThemes(monaco: {
  editor: {
    defineTheme(name: string, data: unknown): void;
  };
}): void {
  monaco.editor.defineTheme('pdv-monokai', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment',            foreground: '75715e', fontStyle: 'italic' },
      { token: 'keyword',            foreground: 'f92672' },
      { token: 'keyword.operator',   foreground: 'f92672' },
      { token: 'number',             foreground: 'ae81ff' },
      { token: 'string',             foreground: 'e6db74' },
      { token: 'string.escape',      foreground: 'ae81ff' },
      { token: 'type',               foreground: '66d9ef', fontStyle: 'italic' },
      { token: 'type.identifier',    foreground: '66d9ef', fontStyle: 'italic' },
      { token: 'identifier',         foreground: 'f8f8f2' },
      { token: 'function',           foreground: 'a6e22e' },
      { token: 'delimiter',          foreground: 'f8f8f2' },
    ],
    colors: {
      'editor.background':            '#272822',
      'editor.foreground':            '#f8f8f2',
      'editor.selectionBackground':   '#49483e',
      'editor.lineHighlightBackground': '#3e3f3880',
      'editorCursor.foreground':      '#f8f8f2',
      'editorLineNumber.foreground':  '#75715e',
      'editorIndentGuide.background': '#3b3a32',
    },
  });

  monaco.editor.defineTheme('pdv-xcode-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment',            foreground: '008E00', fontStyle: 'italic' },
      { token: 'keyword',            foreground: 'C800A4' },
      { token: 'keyword.operator',   foreground: 'C800A4' },
      { token: 'string',             foreground: 'DF0002' },
      { token: 'string.escape',      foreground: 'DF0002' },
      { token: 'number',             foreground: '3A00DC' },
      { token: 'constant.language',  foreground: 'C800A4' },
      { token: 'type',               foreground: '438288' },
      { token: 'type.identifier',    foreground: '438288' },
      { token: 'entity.name.class',  foreground: '438288' },
      { token: 'support',            foreground: '450084' },
      { token: 'support.function',   foreground: '450084' },
      { token: 'variable',           foreground: 'C800A4' },
    ],
    colors: {
      'editor.background':              '#ffffff',
      'editor.foreground':              '#000000',
      'editor.selectionBackground':     '#b5d5ff',
      'editor.lineHighlightBackground': '#eeeeee',
      'editorCursor.foreground':        '#000000',
      'editorLineNumber.foreground':    '#bbbbbb',
      'editorLineNumber.activeForeground': '#666666',
    },
  });

  monaco.editor.defineTheme('pdv-xcode-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment',            foreground: '6C7986', fontStyle: 'italic' },
      { token: 'keyword',            foreground: 'FC5FA3' },
      { token: 'keyword.operator',   foreground: 'FC5FA3' },
      { token: 'string',             foreground: 'FC6A5D' },
      { token: 'string.escape',      foreground: 'FC6A5D' },
      { token: 'number',             foreground: '9686F5' },
      { token: 'constant.language',  foreground: '9686F5' },
      { token: 'variable',           foreground: '53A5FB' },
      { token: 'variable.parameter', foreground: 'FD8F3F' },
      { token: 'type',               foreground: '91D462' },
      { token: 'type.identifier',    foreground: '91D462' },
      { token: 'entity.name.class',  foreground: '91D462' },
      { token: 'function',           foreground: '91D462' },
      { token: 'support',            foreground: '7AC8B6' },
      { token: 'support.function',   foreground: '7AC8B6' },
    ],
    colors: {
      'editor.background':              '#242529',
      'editor.foreground':              '#ffffff',
      'editor.selectionBackground':     '#444444',
      'editor.lineHighlightBackground': '#303239',
      'editorCursor.foreground':        '#ffffff',
      'editorLineNumber.foreground':    '#6c6b70',
    },
  });
}

/**
 * Return the Monaco theme identifier for the given PDV theme name.
 * Falls back to `vs-dark` for unknown / custom themes whose base cannot be determined.
 */
export function getMonacoTheme(themeName: string, allThemes: BuiltinTheme[]): string {
  const builtin = allThemes.find((t) => t.name === themeName);
  if (builtin) return builtin.monacoTheme;
  // Custom themes derived from a built-in carry "(Custom)" suffix; try to match.
  for (const bt of allThemes) {
    if (themeName.startsWith(bt.name)) return bt.monacoTheme;
  }
  return 'vs-dark';
}

/** Apply a color map directly to CSS custom properties on :root. */
export function applyThemeColors(colors: Record<string, string>): void {
  Object.entries(colors).forEach(([key, value]) => {
    document.documentElement.style.setProperty(`--${key}`, value);
  });
}

/** Return true if two color maps are equal. */
export function colorsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

// ---------------------------------------------------------------------------
// Font detection
// ---------------------------------------------------------------------------

/** Curated list of popular monospace fonts to probe for. */
const MONO_FONT_CANDIDATES = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Cascadia Mono',
  'Source Code Pro',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'IBM Plex Mono',
  'Hack',
  'Inconsolata',
  'Roboto Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Droid Sans Mono',
  'Courier New',
  'Lucida Console',
  'Andale Mono',
  'PT Mono',
  'Iosevka',
  'Victor Mono',
  'Mononoki',
  'Fantasque Sans Mono',
  'Noto Sans Mono',
];

/** Curated list of popular display/UI fonts to probe for. */
const DISPLAY_FONT_CANDIDATES = [
  'Inter',
  'SF Pro Display',
  'SF Pro Text',
  'Helvetica Neue',
  'Helvetica',
  'Arial',
  'Roboto',
  'Open Sans',
  'Lato',
  'Nunito',
  'Segoe UI',
  'Ubuntu',
  'Cantarell',
  'Noto Sans',
  'Source Sans Pro',
  'Raleway',
  'Fira Sans',
  'IBM Plex Sans',
  'DM Sans',
];

/**
 * Returns true if the named font is installed, by checking whether it renders
 * differently from a pure fallback font on a canvas.
 */
function fontInstalled(family: string, fallback: 'monospace' | 'sans-serif' = 'sans-serif'): boolean {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const probe = 'abcdefghijklmnopqrstuvwxyz0123456789MMWWII';
  ctx.font = `16px ${fallback}`;
  const wFallback = ctx.measureText(probe).width;
  ctx.font = `16px '${family}', ${fallback}`;
  const wFont = ctx.measureText(probe).width;
  return Math.abs(wFont - wFallback) > 0.5;
}

/** Returns installed monospace fonts from the candidate list. */
export function detectMonoFonts(): string[] {
  return MONO_FONT_CANDIDATES.filter((f) => fontInstalled(f, 'monospace'));
}

/** Returns installed display fonts from the candidate list. */
export function detectDisplayFonts(): string[] {
  return DISPLAY_FONT_CANDIDATES.filter((f) => fontInstalled(f, 'sans-serif'));
}

/**
 * Apply code/display font choices as CSS custom properties so the entire app
 * (and Monaco, which is passed the value directly) reflects the selection.
 *
 * Pass `undefined` to revert to the stylesheet default.
 */
export function applyFontSettings(codeFont?: string, displayFont?: string): void {
  const root = document.documentElement;
  if (codeFont) {
    root.style.setProperty('--font-mono', `'${codeFont}', ui-monospace, 'Courier New', monospace`);
  } else {
    root.style.removeProperty('--font-mono');
  }
  if (displayFont) {
    root.style.setProperty('--font-sans', `'${displayFont}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`);
  } else {
    root.style.removeProperty('--font-sans');
  }
}
