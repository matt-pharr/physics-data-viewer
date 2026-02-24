/**
 * Tests for LSP IPC handlers and related index.ts helpers
 *
 * We test that lsp:configure correctly persists user config, and that
 * lsp:list correctly merges registry definitions with server statuses.
 * The core logic is exercised through the LspServerManager + LspRegistry
 * integration used by those handlers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── lsp:configure handler logic ─────────────────────────────────────────────

describe('lsp:configure handler logic', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('merges new config over existing user config for a language', async () => {
    let savedConfig: Record<string, unknown> = {
      pythonPath: 'python3',
      languageServers: {
        python: { enabled: true, autoStart: false },
      },
    };

    vi.doMock('./config', () => ({
      loadConfig: () => structuredClone(savedConfig),
      updateConfig: (partial: Record<string, unknown>) => {
        savedConfig = { ...savedConfig, ...partial };
      },
    }));
    vi.doMock('electron', () => ({
      ipcMain: { handle: vi.fn() },
      app: { on: vi.fn() },
      dialog: {},
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { loadConfig, updateConfig } = await import('./config');

    // Simulate the configure handler logic
    const languageId = 'python';
    const userConfigUpdate = { autoStart: true, command: 'pylsp' };

    const current = loadConfig();
    const existing = (current.languageServers ?? {})[languageId] ?? { enabled: true, autoStart: false };
    const updated = { ...existing, ...userConfigUpdate };
    updateConfig({
      languageServers: {
        ...(current.languageServers ?? {}),
        [languageId]: updated,
      },
    });

    const final = loadConfig();
    expect((final.languageServers as Record<string, unknown>).python).toMatchObject({
      enabled: true,
      autoStart: true,
      command: 'pylsp',
    });
  });

  it('creates languageServers map if it does not exist in config', async () => {
    let savedConfig: Record<string, unknown> = {
      pythonPath: 'python3',
      // no languageServers key
    };

    vi.doMock('./config', () => ({
      loadConfig: () => structuredClone(savedConfig),
      updateConfig: (partial: Record<string, unknown>) => {
        savedConfig = { ...savedConfig, ...partial };
      },
    }));

    const { loadConfig, updateConfig } = await import('./config');

    const languageId = 'julia';
    const userConfigUpdate = { autoStart: false, enabled: true };

    const current = loadConfig();
    const existing = ((current.languageServers ?? {}) as Record<string, unknown>)[languageId] as Record<string, unknown> ?? { enabled: true, autoStart: false };
    const updated = { ...existing, ...userConfigUpdate };
    updateConfig({
      languageServers: {
        ...((current.languageServers as Record<string, unknown>) ?? {}),
        [languageId]: updated,
      },
    });

    const final = loadConfig();
    expect((final.languageServers as Record<string, Record<string, unknown>>).julia).toBeDefined();
    expect((final.languageServers as Record<string, Record<string, unknown>>).julia.enabled).toBe(true);
  });

  it('does not remove existing configs for other languages when updating one', async () => {
    let savedConfig: Record<string, unknown> = {
      languageServers: {
        python: { enabled: true, autoStart: true },
        julia: { enabled: false, autoStart: false },
      },
    };

    vi.doMock('./config', () => ({
      loadConfig: () => structuredClone(savedConfig),
      updateConfig: (partial: Record<string, unknown>) => {
        savedConfig = { ...savedConfig, ...partial };
      },
    }));

    const { loadConfig, updateConfig } = await import('./config');

    // Update only python
    const current = loadConfig();
    const existing = ((current.languageServers ?? {}) as Record<string, unknown>).python as Record<string, unknown> ?? {};
    updateConfig({
      languageServers: {
        ...((current.languageServers as Record<string, unknown>) ?? {}),
        python: { ...existing, autoStart: false },
      },
    });

    const final = loadConfig();
    const ls = final.languageServers as Record<string, Record<string, unknown>>;
    // Python updated
    expect(ls.python.autoStart).toBe(false);
    // Julia untouched
    expect(ls.julia).toMatchObject({ enabled: false, autoStart: false });
  });
});

// ─── lsp:list handler logic ───────────────────────────────────────────────────

describe('lsp:list handler logic', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns all registered languages with their statuses', async () => {
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspRegistry } = await import('./lsp-registry');
    const { getLspServerManager, resetLspServerManager } = await import('./lsp-server-manager');
    resetLspServerManager();

    const registry = getLspRegistry();
    const manager = getLspServerManager();

    const defs = registry.list();
    const result = defs.map((def) => ({
      languageId: def.languageId,
      displayName: def.displayName,
      fileExtensions: def.fileExtensions,
      documentationUrl: def.documentationUrl,
      installHint: def.installHint,
      autoStartDefault: def.autoStartDefault,
      source: def.source,
      status: manager.getStatus(def.languageId),
      userConfig: undefined,
    }));

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.find((r) => r.languageId === 'python')).toBeDefined();
    expect(result.find((r) => r.languageId === 'julia')).toBeDefined();

    for (const entry of result) {
      expect(entry.status).toBeDefined();
      expect(entry.status.languageId).toBe(entry.languageId);
    }

    resetLspServerManager();
  });

  it('initial status is not_configured before any detection', async () => {
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspServerManager, resetLspServerManager } = await import('./lsp-server-manager');
    resetLspServerManager();
    const manager = getLspServerManager();

    expect(manager.getStatus('python').state).toBe('not_configured');
    expect(manager.getStatus('julia').state).toBe('not_configured');

    resetLspServerManager();
  });

  it('includes userConfig from app config when present', async () => {
    vi.doMock('./config', () => ({
      loadConfig: () => ({
        pythonPath: 'python3',
        languageServers: {
          python: { enabled: true, autoStart: true, command: 'pylsp' },
        },
      }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspRegistry } = await import('./lsp-registry');
    const { getLspServerManager, resetLspServerManager } = await import('./lsp-server-manager');
    const { loadConfig } = await import('./config');
    resetLspServerManager();

    const registry = getLspRegistry();
    const manager = getLspServerManager();
    const config = loadConfig();

    const result = registry.list().map((def) => ({
      languageId: def.languageId,
      status: manager.getStatus(def.languageId),
      userConfig: config.languageServers?.[def.languageId],
    }));

    const pythonEntry = result.find((r) => r.languageId === 'python')!;
    expect(pythonEntry.userConfig).toMatchObject({
      enabled: true,
      autoStart: true,
      command: 'pylsp',
    });

    resetLspServerManager();
  });
});

// ─── LspServerStatus shape ────────────────────────────────────────────────────

describe('LspServerStatus shape', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('getStatus() always returns a status with the requested languageId', async () => {
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));

    const { getLspServerManager, resetLspServerManager } = await import('./lsp-server-manager');
    resetLspServerManager();
    const manager = getLspServerManager();

    for (const id of ['python', 'julia', 'unknown-lang']) {
      const status = manager.getStatus(id);
      expect(status.languageId).toBe(id);
      expect(typeof status.state).toBe('string');
    }

    resetLspServerManager();
  });

  it('displayName is populated on statuses returned by listStatuses()', async () => {
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));

    const { getLspServerManager, resetLspServerManager } = await import('./lsp-server-manager');
    resetLspServerManager();
    const manager = getLspServerManager();

    // listStatuses() goes through toStatus() which includes displayName from registry
    const statuses = manager.listStatuses();
    const python = statuses.find((s) => s.languageId === 'python');
    const julia = statuses.find((s) => s.languageId === 'julia');
    expect(python?.displayName).toBe('Python');
    expect(julia?.displayName).toBe('Julia');

    resetLspServerManager();
  });
});
