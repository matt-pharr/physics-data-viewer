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
    ],
  },
];

/** All CSS variable keys managed by the theme system. */
export const ALL_CSS_VARS: string[] = CSS_VAR_GROUPS.flatMap((g) => g.vars.map((v) => v.key));

export interface BuiltinTheme extends Theme {
  /** Monaco editor theme identifier. */
  monacoTheme: string;
}

export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    name: 'Dark+ (VSCode)',
    monacoTheme: 'vs-dark',
    colors: {
      // Backgrounds — based on VSCode Default Dark+
      'bg-primary':   '#1e1e1e',
      'bg-secondary': '#252526',
      'bg-tertiary':  '#2d2d30',
      'bg-hover':     '#2a2d2e',
      // Text
      'text-primary':   '#d4d4d4',
      'text-secondary': '#858585',
      'text-hint':      '#5a5a5a',
      // Accents & Borders
      'accent':       '#007acc',
      'accent-hover': '#1a8fd1',
      'border-color': '#474747',
      'error':        '#f48771',
    },
  },
  {
    name: 'Light+ (VSCode)',
    monacoTheme: 'vs',
    colors: {
      // Backgrounds — based on VSCode Default Light+
      'bg-primary':   '#ffffff',
      'bg-secondary': '#f3f3f3',
      'bg-tertiary':  '#ebebeb',
      'bg-hover':     '#e8e8e8',
      // Text
      'text-primary':   '#383838',
      'text-secondary': '#717171',
      'text-hint':      '#aaaaaa',
      // Accents & Borders
      'accent':       '#007acc',
      'accent-hover': '#005a9e',
      'border-color': '#d4d4d4',
      'error':        '#e51400',
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
    },
  },
];

export const BUILTIN_THEME_NAMES = new Set(BUILTIN_THEMES.map((t) => t.name));

/**
 * A named pairing that associates a dark and light variant of the same theme family.
 * Used to enable automatic switching based on `prefers-color-scheme`.
 */
export interface ThemePair {
  /** Human-readable name for the pair (shown in settings). */
  name: string;
  dark: string;
  light: string;
}

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
