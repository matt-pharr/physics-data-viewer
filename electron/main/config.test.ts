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

  it('creates a timestamped default tree root with standard subdirectories', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    expect(config.treeRoot).toBeTruthy();

    const treeRoot = config.treeRoot as string;
    const projectDir = path.dirname(treeRoot);
    const rawUsername = os.userInfo().username || 'user';
    const username = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '_');
    expect(path.dirname(projectDir)).toBe(path.join(os.tmpdir(), username));
    expect(path.basename(projectDir)).toMatch(/^PDV-\d{4}_\d{2}_\d{2}_\d{2}:\d{2}:\d{2}$/);
    expect(fs.existsSync(path.join(treeRoot, 'data'))).toBe(true);
    expect(fs.existsSync(path.join(treeRoot, 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(treeRoot, 'results'))).toBe(true);
  });

  it('migrates legacy /tmp/{username}/PDV/tree root to timestamped PDV directory', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const rawUsername = os.userInfo().username || 'user';
    const username = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '_');
    const legacyTreeRoot = path.join(os.tmpdir(), username, 'PDV', 'tree');
    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ treeRoot: legacyTreeRoot }), 'utf-8');

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    expect(config.treeRoot).not.toBe(legacyTreeRoot);
    expect(path.basename(path.dirname(config.treeRoot as string))).toMatch(/^PDV-\d{4}_\d{2}_\d{2}_\d{2}:\d{2}:\d{2}$/);
  });
});
