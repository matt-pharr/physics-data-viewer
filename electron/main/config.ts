import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from './ipc';

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
      cachedConfig = merged;
      return cachedConfig;
    }
    // If no config exists yet, trigger first-run flow by omitting executable paths.
    cachedConfig = { ...DEFAULT_CONFIG, pythonPath: undefined, juliaPath: undefined };
    return cachedConfig;
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? '[config] Invalid config format, using defaults:'
        : '[config] Failed to load config, using defaults:';
    console.error(message, error);
  }

  cachedConfig = { ...DEFAULT_CONFIG };
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
