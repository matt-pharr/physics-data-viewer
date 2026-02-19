import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('config themes', () => {
  const originalHome = process.env.HOME;
  let tempHome: string | undefined;

  afterEach(() => {
    process.env.HOME = originalHome;
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
    vi.resetModules();
  });

  it('stores themes in ~/.pdv/themes directory and discovers individual files', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const { loadThemes, saveTheme } = await import('./config');
    const initialThemes = loadThemes();
    expect(initialThemes.some((theme) => theme.name === 'Dark')).toBe(true);
    const themesDir = path.join(tempHome, '.pdv', 'themes');
    expect(fs.existsSync(themesDir)).toBe(true);
    expect(fs.statSync(themesDir).isDirectory()).toBe(true);

    saveTheme({
      name: 'My Custom Theme',
      colors: {
        'bg-primary': '#101010',
      },
    });

    fs.writeFileSync(
      path.join(themesDir, 'discovered-theme.json'),
      JSON.stringify({
        name: 'Discovered Theme',
        colors: { 'bg-primary': '#202020' },
      }),
      'utf-8',
    );

    const afterSave = loadThemes();
    expect(afterSave.some((theme) => theme.name === 'My Custom Theme')).toBe(true);
    expect(afterSave.some((theme) => theme.name === 'Discovered Theme')).toBe(true);
    expect(fs.existsSync(path.join(themesDir, 'my-custom-theme.json'))).toBe(true);
  });
});
