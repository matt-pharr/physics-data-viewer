import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shared helper to create a mock electron env
function mockElectronWithHome(tempHome: string) {
  vi.doMock('electron', () => ({
    app: {
      getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
    },
  }));
}

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

  it('refreshes previously stored timestamped default tree root to a new timestamped directory', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const rawUsername = os.userInfo().username || 'user';
    const username = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '_');
    const oldTimestampTreeRoot = path.join(os.tmpdir(), username, 'PDV-2020_01_01_00:00:00', 'tree');
    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ treeRoot: oldTimestampTreeRoot }), 'utf-8');

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    expect(config.treeRoot).not.toBe(oldTimestampTreeRoot);
    expect(path.basename(path.dirname(config.treeRoot as string))).toMatch(/^PDV-\d{4}_\d{2}_\d{2}_\d{2}:\d{2}:\d{2}$/);
  });

  it('preserves explicit custom tree root paths from settings', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const customTreeRoot = path.join(tempHome, 'custom-project-root', 'tree');
    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ treeRoot: customTreeRoot }), 'utf-8');

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    expect(config.treeRoot).toBe(customTreeRoot);
  });
});

// ─── saveConfig / updateConfig ─────────────────────────────────────────────────

describe('config persistence', () => {
  let tempHome: string;

  afterEach(() => {
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it('saveConfig writes settings to disk and updates the in-memory cache', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const { loadConfig, saveConfig } = await import('./config');
    const config = loadConfig();
    const updated = { ...config, plotMode: 'inline' as const };
    saveConfig(updated);

    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(written.plotMode).toBe('inline');

    // The in-memory cache should reflect the new value
    const cached = loadConfig();
    expect(cached.plotMode).toBe('inline');
  });

  it('updateConfig merges a partial config, saves it, and returns the merged result', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const { loadConfig, updateConfig } = await import('./config');
    loadConfig(); // warm cache
    const result = updateConfig({ plotMode: 'inline' });
    expect(result.plotMode).toBe('inline');

    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(written.plotMode).toBe('inline');
  });

  it('loadConfig falls back to defaults when settings file contains corrupt JSON', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ this is not valid json }', 'utf-8');

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    // Should still return a valid config with defaults
    expect(config).toBeTruthy();
    expect(config.plotMode).toBe('native');
  });

  it('loadConfig returns cached result on second call without re-reading disk', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const { loadConfig } = await import('./config');
    const first = loadConfig();
    // Write a different value directly to disk
    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ plotMode: 'inline' }), 'utf-8');

    const second = loadConfig();
    // Cache should be the same object reference and have the original value
    expect(second).toBe(first);
  });
});

// ─── theme validation (isTheme) ────────────────────────────────────────────────

describe('config theme validation via loadThemes', () => {
  let tempHome: string;

  afterEach(() => {
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it('skips theme files with corrupt JSON', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const themesDir = path.join(tempHome, '.pdv', 'themes');
    fs.mkdirSync(themesDir, { recursive: true });
    // Valid theme
    fs.writeFileSync(
      path.join(themesDir, 'good.json'),
      JSON.stringify({ name: 'Good', colors: { 'bg-primary': '#111' } }),
    );
    // Corrupt JSON
    fs.writeFileSync(path.join(themesDir, 'corrupt.json'), '{ bad json ');

    const { loadThemes } = await import('./config');
    const themes = loadThemes();
    expect(themes.some((t) => t.name === 'Good')).toBe(true);
    // corrupt file should be silently skipped
    const names = themes.map((t) => t.name);
    expect(names).not.toContain(undefined);
  });

  it('skips theme files that fail isTheme validation (missing name)', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const themesDir = path.join(tempHome, '.pdv', 'themes');
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(
      path.join(themesDir, 'no-name.json'),
      JSON.stringify({ colors: { 'bg-primary': '#111' } }),
    );
    fs.writeFileSync(
      path.join(themesDir, 'valid.json'),
      JSON.stringify({ name: 'Valid', colors: { 'bg-primary': '#222' } }),
    );

    const { loadThemes } = await import('./config');
    const themes = loadThemes();
    expect(themes.some((t) => t.name === 'Valid')).toBe(true);
    // 'no-name' has no name property so isTheme returns false, it must not appear
    expect(themes.every((t) => typeof t.name === 'string')).toBe(true);
  });

  it('skips theme files with empty colors object', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const themesDir = path.join(tempHome, '.pdv', 'themes');
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(
      path.join(themesDir, 'empty-colors.json'),
      JSON.stringify({ name: 'Empty', colors: {} }),
    );

    const { loadThemes } = await import('./config');
    const themes = loadThemes();
    expect(themes.some((t) => t.name === 'Empty')).toBe(false);
  });

  it('falls back to DEFAULT_THEMES when all theme files are invalid', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const themesDir = path.join(tempHome, '.pdv', 'themes');
    fs.mkdirSync(themesDir, { recursive: true });
    // Write one file that is syntactically valid but fails isTheme
    fs.writeFileSync(path.join(themesDir, 'bad.json'), JSON.stringify({ foo: 'bar' }));

    const { loadThemes } = await import('./config');
    const themes = loadThemes();
    // Falls back to DEFAULT_THEMES (Dark + Light)
    expect(themes.some((t) => t.name === 'Dark')).toBe(true);
  });

  it('saveTheme uses a filename slug (e.g. "My Theme!" → my-theme-.json)', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    mockElectronWithHome(tempHome);

    const { saveTheme } = await import('./config');
    saveTheme({ name: 'My Theme!', colors: { 'bg-primary': '#333' } });

    const themesDir = path.join(tempHome, '.pdv', 'themes');
    const files = fs.readdirSync(themesDir);
    // "My Theme!" → lowercase → "my theme!" → non-alpha replaced with "-" → "my-theme-" → trailing dash stripped → "my-theme"
    expect(files.some((f) => f === 'my-theme.json')).toBe(true);
  });
});

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

  it('refreshes previously stored timestamped default tree root to a new timestamped directory', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const rawUsername = os.userInfo().username || 'user';
    const username = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '_');
    const oldTimestampTreeRoot = path.join(os.tmpdir(), username, 'PDV-2020_01_01_00:00:00', 'tree');
    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ treeRoot: oldTimestampTreeRoot }), 'utf-8');

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    expect(config.treeRoot).not.toBe(oldTimestampTreeRoot);
    expect(path.basename(path.dirname(config.treeRoot as string))).toMatch(/^PDV-\d{4}_\d{2}_\d{2}_\d{2}:\d{2}:\d{2}$/);
  });

  it('preserves explicit custom tree root paths from settings', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-home-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: (target: string) => (target === 'home' ? tempHome : tempHome),
      },
    }));

    const customTreeRoot = path.join(tempHome, 'custom-project-root', 'tree');
    const settingsPath = path.join(tempHome, '.PDV', 'settings');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ treeRoot: customTreeRoot }), 'utf-8');

    const { loadConfig } = await import('./config');
    const config = loadConfig();
    expect(config.treeRoot).toBe(customTreeRoot);
  });
});
