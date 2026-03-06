import { useEffect, useState } from 'react';
import type { Config } from '../types';
import { BUILTIN_THEMES, applyThemeColors, applyFontSettings, getMonacoTheme, resolveThemeColors } from '../themes';

interface UseThemeManagerOptions {
  config: Config | null;
}

/**
 * Manage theme colors, Monaco editor theme, and font settings.
 *
 * Tracks `prefers-color-scheme` and applies the correct theme palette
 * whenever `config.settings.appearance` or the system preference changes.
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
      const themeName = systemPrefersDark ? app.darkTheme : app.lightTheme;
      const colors = resolveThemeColors(themeName, []);
      if (colors) {
        applyThemeColors(colors);
        setMonacoTheme(getMonacoTheme(themeName ?? '', BUILTIN_THEMES));
      }
    } else {
      if (app.colors) applyThemeColors(app.colors);
      setMonacoTheme(getMonacoTheme(app.themeName ?? '', BUILTIN_THEMES));
    }
  }, [config, systemPrefersDark]);

  // Apply font settings whenever config changes
  useEffect(() => {
    const fonts = config?.settings?.fonts;
    applyFontSettings(fonts?.codeFont, fonts?.displayFont);
  }, [config]);

  return monacoTheme;
}
