import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSettingsDir,
  getSettingsPath,
  ensureSettingsDir,
  loadSettings,
  saveSettings,
  updateSettings,
} from './settings';

describe('Settings', () => {
  const testDir = path.join(os.tmpdir(), 'pdv-test-settings');
  
  beforeEach(() => {
    // Clean up test directory before each test
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory after each test
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should return correct settings directory path', () => {
    const dir = getSettingsDir();
    expect(dir).toContain('.PDV');
    expect(dir).toContain('settings');
  });

  it('should return correct settings file path', () => {
    const filePath = getSettingsPath();
    expect(filePath).toContain('.PDV');
    expect(filePath).toContain('settings');
    expect(filePath).toContain('config.json');
  });

  it('should create settings directory if it does not exist', () => {
    ensureSettingsDir();
    const dir = getSettingsDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('should load empty settings when file does not exist', () => {
    const settings = loadSettings();
    expect(settings).toEqual({});
  });

  it('should save and load settings', () => {
    const testSettings = {
      pythonPath: '/usr/bin/python3',
      juliaPath: '/usr/bin/julia',
    };
    
    saveSettings(testSettings);
    const loaded = loadSettings();
    
    expect(loaded).toEqual(testSettings);
  });

  it('should update settings by merging with existing', () => {
    const initial = {
      pythonPath: '/usr/bin/python3',
      juliaPath: '/usr/bin/julia',
    };
    
    saveSettings(initial);
    
    const updated = updateSettings({
      pythonPath: '/usr/local/bin/python3',
    });
    
    expect(updated.pythonPath).toBe('/usr/local/bin/python3');
    expect(updated.juliaPath).toBe('/usr/bin/julia');
  });

  it('should handle complex settings with nested objects', () => {
    const testSettings = {
      pythonPath: '/usr/bin/python3',
      editors: {
        python: 'code %s',
        julia: 'code %s',
        default: 'open %s',
      },
    };
    
    saveSettings(testSettings);
    const loaded = loadSettings();
    
    expect(loaded).toEqual(testSettings);
    expect(loaded.editors?.python).toBe('code %s');
  });

  it('should deep merge nested editor settings', () => {
    const initial = {
      pythonPath: '/usr/bin/python3',
      editors: {
        python: 'code %s',
        julia: 'code %s',
        default: 'open %s',
      },
    };
    
    saveSettings(initial);
    
    // Update only python editor, should preserve julia and default
    const updated = updateSettings({
      editors: {
        python: 'vim %s',
      },
    });
    
    expect(updated.editors?.python).toBe('vim %s');
    expect(updated.editors?.julia).toBe('code %s');
    expect(updated.editors?.default).toBe('open %s');
  });
});
