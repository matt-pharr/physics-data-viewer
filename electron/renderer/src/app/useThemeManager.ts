import { useEffect, useState } from 'react';
import type { Config } from '../types';
import { BUILTIN_THEMES, applyThemeColors, applyFontSettings, applyMarkdownSettings, getMonacoTheme, resolveThemeColors } from '../themes';

/** Push the active theme's bg-primary to main so the BrowserWindow's native
 *  background matches — keeps live-resize gestures from flashing the OS default. */
function syncWindowBackground(colors: Record<string, string> | undefined): void {
  const bg = colors?.['bg-primary'];
  if (!bg) return;
  void window.pdv.window?.setBackgroundColor(bg);
}

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
      // The dark/light pair may name a user-saved custom theme, so the
      // saved-themes store must be consulted — resolving against the
      // built-ins alone silently fails to apply custom pair members.
      let cancelled = false;
      void window.pdv.themes
        .get()
        .catch(() => [])
        .then((savedThemes) => {
          if (cancelled) return;
          const darkColors = resolveThemeColors(app.darkTheme, savedThemes);
          const lightColors = resolveThemeColors(app.lightTheme, savedThemes);
          const colors = systemPrefersDark ? darkColors : lightColors;
          if (colors) {
            applyThemeColors(colors);
            syncWindowBackground(colors);
            setMonacoTheme(getMonacoTheme(
              (systemPrefersDark ? app.darkTheme : app.lightTheme) ?? '', BUILTIN_THEMES,
            ));
          }
          cacheTheme({ followSystem: true, darkColors, lightColors });
        });
      return () => {
        cancelled = true;
      };
    } else {
      if (app.colors) {
        applyThemeColors(app.colors);
        syncWindowBackground(app.colors);
        cacheTheme({ followSystem: false, colors: app.colors });
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deriving Monaco theme from config on change
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
