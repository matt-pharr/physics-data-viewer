import { useEffect, useState } from 'react';
import type { Config } from '../types';
import { BUILTIN_THEMES, applyThemeColors, applyFontSettings, applyMarkdownSettings, getMonacoTheme, resolveThemeColors } from '../themes';

/** localStorage key used by the blocking theme script in index.html. */
const THEME_CACHE_KEY = 'pdv-theme-cache';

/** Options for {@link useThemeManager}. */
interface UseThemeManagerOptions {
  /** App configuration containing settings.appearance and settings.fonts. */
  config: Config | null;
}

/**
 * Manage theme colors, Monaco editor theme, and font settings.
 *
 * Tracks `prefers-color-scheme` and applies the correct theme palette
 * whenever `config.settings.appearance` or the system preference changes.
 * After every application, the resolved colors are written to localStorage
 * so the blocking script in `index.html` can apply them before first paint
 * on the next launch.
 *
 * @returns The Monaco theme name to pass to CodeCell.
 */
export function useThemeManager({ config }: UseThemeManagerOptions): string {
  const [monacoTheme, setMonacoTheme] = useState<string>('vs-dark');
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  // Track system color-scheme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Apply theme whenever config or system preference changes
  useEffect(() => {
    if (!config?.settings?.appearance) return;
    const app = config.settings.appearance;
    if (app.followSystemTheme) {
      const darkColors = resolveThemeColors(app.darkTheme, []);
      const lightColors = resolveThemeColors(app.lightTheme, []);
      const colors = systemPrefersDark ? darkColors : lightColors;
      if (colors) {
        applyThemeColors(colors);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- deriving Monaco theme from config on change
        setMonacoTheme(getMonacoTheme(
          (systemPrefersDark ? app.darkTheme : app.lightTheme) ?? '', BUILTIN_THEMES,
        ));
      }
      cacheTheme({ followSystem: true, darkColors, lightColors });
    } else {
      if (app.colors) {
        applyThemeColors(app.colors);
        cacheTheme({ followSystem: false, colors: app.colors });
      }
      setMonacoTheme(getMonacoTheme(app.themeName ?? '', BUILTIN_THEMES));
    }
  }, [config, systemPrefersDark]);

  // Apply font settings whenever config changes
  useEffect(() => {
    const fonts = config?.settings?.fonts;
    applyFontSettings(fonts?.codeFont, fonts?.displayFont);
  }, [config]);

  // Apply markdown settings (read-view max width) whenever config changes
  useEffect(() => {
    applyMarkdownSettings(config?.settings?.markdown?.maxContentWidth);
  }, [config]);

  return monacoTheme;
}

/**
 * Persist resolved theme colors to localStorage so the blocking script in
 * `index.html` can apply them before first paint on the next launch.
 */
function cacheTheme(entry: {
  followSystem: boolean;
  colors?: Record<string, string>;
  darkColors?: Record<string, string>;
  lightColors?: Record<string, string>;
}): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(entry));
  } catch { /* storage full or unavailable — non-critical */ }
}
