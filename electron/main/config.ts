import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Config } from './ipc';

/**
 * Get or create the tree root directory in /tmp
 * Format: /tmp/{username}/PDV/tree
 * This creates a persistent location outside the repository to avoid Vite file watching
 */
function getDefaultTreeRoot(): string {
  const username = os.userInfo().username || 'user';
  return path.join(os.tmpdir(), username, 'PDV', 'tree');
}

/**
 * Ensure the tree root directory exists and has standard subdirectories
 */
function ensureTreeRoot(treeRoot: string): void {
  try {
    if (!fs.existsSync(treeRoot)) {
      fs.mkdirSync(treeRoot, { recursive: true });
      fs.mkdirSync(path.join(treeRoot, 'data'), { recursive: true });
      fs.mkdirSync(path.join(treeRoot, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(treeRoot, 'results'), { recursive: true });
      console.log('[config] Created tree root at:', treeRoot);
    }
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
};

function getConfigPath(): string {
  try {
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('userData'), 'config.json');
    }
  } catch (error) {
    console.error('[config] Failed to resolve userData path, falling back to cwd:', error);
  }
  return path.join(process.cwd(), 'config.json');
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = getConfigPath();

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
  const configPath = getConfigPath();
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
