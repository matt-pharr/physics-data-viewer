import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Config, Theme } from './ipc';

const DEFAULT_THEME_COLORS: Record<string, string> = {
  'bg-primary': '#1e1e1e',
  'bg-secondary': '#252526',
  'bg-tertiary': '#2d2d30',
  'bg-hover': '#3e3e42',
  'border-color': '#3e3e42',
  'text-primary': '#d4d4d4',
  'text-secondary': '#858585',
  accent: '#4ec9b0',
  'accent-hover': '#5fd4be',
  error: '#f48771',
  warning: '#dcdcaa',
  success: '#4ec9b0',
};

const DEFAULT_THEMES: Array<{ name: string; colors: Record<string, string> }> = [
  { name: 'Dark', colors: DEFAULT_THEME_COLORS },
  {
    name: 'Light',
    colors: {
      'bg-primary': '#f3f3f3',
      'bg-secondary': '#ffffff',
      'bg-tertiary': '#f7f7f7',
      'bg-hover': '#e6e6e6',
      'border-color': '#d0d0d0',
      'text-primary': '#1f1f1f',
      'text-secondary': '#4f4f4f',
      accent: '#0078d4',
      'accent-hover': '#268be4',
      error: '#a4262c',
      warning: '#8a6f00',
      success: '#107c10',
    },
  },
];

/**
 * Get or create the tree root directory in /tmp
 * Format: /tmp/{username}/PDV/tree
 * This creates a persistent location outside the repository to avoid Vite file watching
 */
function getDefaultTreeRoot(): string {
  // Sanitize username to be filesystem-safe
  const rawUsername = os.userInfo().username || 'user';
  const username = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), username, 'PDV', 'tree');
}

/**
 * Ensure the tree root directory exists and has standard subdirectories
 */
function ensureTreeRoot(treeRoot: string): void {
  try {
    // Ensure main tree root directory exists
    if (!fs.existsSync(treeRoot)) {
      fs.mkdirSync(treeRoot, { recursive: true });
      console.log('[config] Created tree root at:', treeRoot);
    }
    
    // Ensure subdirectories exist (even if tree root already existed)
    const subdirs = ['data', 'scripts', 'results'];
    subdirs.forEach(subdir => {
      const subdirPath = path.join(treeRoot, subdir);
      if (!fs.existsSync(subdirPath)) {
        fs.mkdirSync(subdirPath, { recursive: true });
      }
    });
  } catch (error) {
    console.error('[config] Failed to create tree root:', error);
  }
}

const DEFAULT_CONFIG: Config = {
  kernelSpec: null,
  plotMode: 'native',
  cwd: process.cwd(),
  trusted: false,
  recentProjects: [],
  customKernels: [],
  pythonPath: 'python3',
  juliaPath: 'julia',
  editors: {
    python: 'code %s',
    julia: 'code %s',
    default: 'open %s',
  },
  projectRoot: process.cwd(),
  treeRoot: getDefaultTreeRoot(),
  settings: {
    shortcuts: {
      openSettings: 'CommandOrControl+,',
    },
    appearance: {
      themeName: 'Dark',
      colors: DEFAULT_THEME_COLORS,
    },
  },
};

function getSettingsPath(): string {
  return path.join(getPdvDirectory(), 'settings');
}

function getThemesPath(): string {
  return path.join(getThemeDirectoryBase(), 'themes');
}

function getThemeDirectoryBase(): string {
  try {
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('home'), '.pdv');
    }
  } catch (error) {
    console.error('[config] Failed to resolve home path for themes, falling back to os.homedir:', error);
  }
  return path.join(os.homedir(), '.pdv');
}

function getPdvDirectory(): string {
  try {
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('home'), '.PDV');
    }
  } catch (error) {
    console.error('[config] Failed to resolve home path, falling back to os.homedir:', error);
  }
  return path.join(os.homedir(), '.PDV');
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = getSettingsPath();

  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<Config>;
      const merged = { ...DEFAULT_CONFIG, ...parsed };
      ['pythonPath', 'juliaPath'].forEach((key) => {
        if (!(key in parsed)) {
          (merged as Record<string, unknown>)[key] = undefined;
        }
      });
      // Ensure treeRoot exists
      if (merged.treeRoot) {
        ensureTreeRoot(merged.treeRoot);
      }
      cachedConfig = merged;
      return cachedConfig;
    }
    // If no config exists yet, trigger first-run flow by omitting executable paths.
    const initialConfig = { ...DEFAULT_CONFIG, pythonPath: undefined, juliaPath: undefined };
    // Ensure treeRoot exists
    if (initialConfig.treeRoot) {
      ensureTreeRoot(initialConfig.treeRoot);
    }
    cachedConfig = initialConfig;
    return cachedConfig;
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? '[config] Invalid config format, using defaults:'
        : '[config] Failed to load config, using defaults:';
    console.error(message, error);
  }

  cachedConfig = { ...DEFAULT_CONFIG };
  // Ensure treeRoot exists
  if (cachedConfig.treeRoot) {
    ensureTreeRoot(cachedConfig.treeRoot);
  }
  return cachedConfig;
}

export function saveConfig(config: Config): void {
  const configPath = getSettingsPath();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    cachedConfig = config;
  } catch (error) {
    console.error('[config] Failed to save config:', error);
  }
}

export function updateConfig(partial: Partial<Config>): Config {
  const current = loadConfig();
  const next = { ...current, ...partial };
  saveConfig(next);
  return next;
}

function toThemeFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'theme'}.json`;
}

function isTheme(value: unknown): value is Theme {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { name?: unknown; colors?: unknown };
  if (typeof candidate.name !== 'string' || !candidate.colors || typeof candidate.colors !== 'object') {
    return false;
  }
  return Object.values(candidate.colors as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function ensureDefaultThemes(): void {
  const themesPath = getThemesPath();
  if (!fs.existsSync(themesPath)) {
    fs.mkdirSync(themesPath, { recursive: true });
  }
  const themeFiles = fs.readdirSync(themesPath).filter((file) => file.endsWith('.json'));
  if (themeFiles.length === 0) {
    DEFAULT_THEMES.forEach((theme) => {
      const filePath = path.join(themesPath, toThemeFileName(theme.name));
      fs.writeFileSync(filePath, JSON.stringify(theme, null, 2), 'utf-8');
    });
  }
}

export function loadThemes(): Theme[] {
  const themesPath = getThemesPath();
  try {
    ensureDefaultThemes();
    const files = fs.readdirSync(themesPath).filter((file) => file.endsWith('.json'));
    const loadedThemes: Theme[] = [];
    files.forEach((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(themesPath, file), 'utf-8')) as unknown;
        if (isTheme(parsed)) {
          loadedThemes.push(parsed);
        }
      } catch (error) {
        console.error(`[config] Failed to parse theme file ${file}:`, error);
      }
    });
    return loadedThemes.length > 0 ? loadedThemes : DEFAULT_THEMES;
  } catch (error) {
    console.error('[config] Failed to load themes:', error);
    return DEFAULT_THEMES;
  }
}

export function saveTheme(theme: Theme): void {
  const themesPath = getThemesPath();
  try {
    fs.mkdirSync(themesPath, { recursive: true });
    const filePath = path.join(themesPath, toThemeFileName(theme.name));
    fs.writeFileSync(filePath, JSON.stringify(theme, null, 2), 'utf-8');
  } catch (error) {
    console.error('[config] Failed to save theme:', error);
  }
}
