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

  it('stores themes in ~/.PDV/themes and persists custom themes', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const { loadThemes, saveTheme } = await import('./config');
    const initialThemes = loadThemes();
    expect(initialThemes.some((theme) => theme.name === 'Dark')).toBe(true);
    expect(fs.existsSync(path.join(tempHome, '.PDV', 'themes'))).toBe(true);

    saveTheme({
      name: 'My Custom Theme',
      colors: {
        'bg-primary': '#101010',
      },
    });

    const afterSave = loadThemes();
    expect(afterSave.some((theme) => theme.name === 'My Custom Theme')).toBe(true);
  });
});
