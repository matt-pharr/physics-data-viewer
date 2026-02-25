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

export const BUILTIN_THEMES: Theme[] = [
  {
    name: 'Dark+ (VSCode)',
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
];

export const BUILTIN_THEME_NAMES = new Set(BUILTIN_THEMES.map((t) => t.name));

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
