/**
 * Tests for LspRegistry
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LspRegistry, getLspRegistry } from './lsp-registry';
import type { LspServerDefinition } from './lsp-registry';

// ─── LspRegistry class ────────────────────────────────────────────────────────

describe('LspRegistry', () => {
  it('populates built-in Python definition on construction', () => {
    const registry = new LspRegistry();
    const python = registry.get('python');
    expect(python).toBeDefined();
    expect(python!.languageId).toBe('python');
    expect(python!.displayName).toBe('Python');
    expect(python!.fileExtensions).toContain('.py');
    expect(python!.transport).toBe('stdio');
    expect(python!.candidates.length).toBeGreaterThanOrEqual(1);
    expect(python!.documentationUrl).toContain('http');
    expect(python!.installHint).toMatch(/pip/i);
    expect(typeof python!.autoStartDefault).toBe('boolean');
  });

  it('populates built-in Julia definition on construction', () => {
    const registry = new LspRegistry();
    const julia = registry.get('julia');
    expect(julia).toBeDefined();
    expect(julia!.languageId).toBe('julia');
    expect(julia!.fileExtensions).toContain('.jl');
    expect(julia!.autoStartDefault).toBe(false);
  });

  it('returns undefined for unknown language', () => {
    const registry = new LspRegistry();
    expect(registry.get('cobol')).toBeUndefined();
  });

  it('list() returns all built-in definitions', () => {
    const registry = new LspRegistry();
    const defs = registry.list();
    expect(defs.length).toBeGreaterThanOrEqual(2);
    const ids = defs.map((d) => d.languageId);
    expect(ids).toContain('python');
    expect(ids).toContain('julia');
  });

  it('register() adds a new language definition', () => {
    const registry = new LspRegistry();
    const rDef: LspServerDefinition = {
      languageId: 'r',
      displayName: 'R',
      fileExtensions: ['.r', '.R'],
      transport: 'stdio',
      candidates: [{ command: 'R', args: ['--slave', '-e', 'languageserver::run()'], detectCommand: 'R' }],
      detectPorts: [],
      documentationUrl: 'https://github.com/REditorSupport/languageserver',
      installHint: "R -e 'install.packages(\"languageserver\")'",
      autoStartDefault: false,
    };

    registry.register(rDef);
    expect(registry.get('r')).toBe(rDef);
    expect(registry.list().map((d) => d.languageId)).toContain('r');
  });

  it('register() overwrites an existing definition for the same languageId', () => {
    const registry = new LspRegistry();
    const original = registry.get('python')!;
    const override: LspServerDefinition = { ...original, displayName: 'Python (Override)' };

    registry.register(override);

    expect(registry.get('python')!.displayName).toBe('Python (Override)');
    // Should not duplicate — still only one python entry
    expect(registry.list().filter((d) => d.languageId === 'python').length).toBe(1);
  });

  it('unregister() removes a definition', () => {
    const registry = new LspRegistry();
    registry.unregister('python');
    expect(registry.get('python')).toBeUndefined();
    expect(registry.list().map((d) => d.languageId)).not.toContain('python');
  });

  it('unregister() is a no-op for unknown language', () => {
    const registry = new LspRegistry();
    const countBefore = registry.list().length;
    registry.unregister('cobol'); // should not throw
    expect(registry.list().length).toBe(countBefore);
  });

  it('Python definition has at least three candidates (pylsp, pyright, jedi)', () => {
    const registry = new LspRegistry();
    const python = registry.get('python')!;
    const detectCommands = python.candidates.map((c) => c.detectCommand);
    expect(detectCommands).toContain('pylsp');
    expect(detectCommands).toContain('pyright-langserver');
    expect(detectCommands).toContain('jedi-language-server');
  });

  it('Julia definition uses julia executable as candidate', () => {
    const registry = new LspRegistry();
    const julia = registry.get('julia')!;
    expect(julia.candidates[0].detectCommand).toBe('julia');
    expect(julia.candidates[0].args.join(' ')).toContain('LanguageServer');
  });

  it('each built-in definition has non-empty fileExtensions', () => {
    const registry = new LspRegistry();
    for (const def of registry.list()) {
      expect(def.fileExtensions.length).toBeGreaterThan(0);
    }
  });

  it('source field is undefined on built-in definitions', () => {
    const registry = new LspRegistry();
    for (const def of registry.list()) {
      expect(def.source).toBeUndefined();
    }
  });

  it('register() preserves source attribution for module-contributed definitions', () => {
    const registry = new LspRegistry();
    const def: LspServerDefinition = {
      languageId: 'lua',
      displayName: 'Lua',
      fileExtensions: ['.lua'],
      transport: 'stdio',
      candidates: [{ command: 'lua-language-server', args: [], detectCommand: 'lua-language-server' }],
      detectPorts: [],
      documentationUrl: 'https://luals.github.io',
      installHint: 'brew install lua-language-server',
      autoStartDefault: false,
      source: 'my-lua-module',
    };
    registry.register(def);
    expect(registry.get('lua')!.source).toBe('my-lua-module');
  });
});

// ─── getLspRegistry singleton ─────────────────────────────────────────────────

describe('getLspRegistry singleton', () => {
  // We need vitest module isolation to test the singleton properly
  afterEach(() => {
    // Reset by re-importing with fresh module state
  });

  it('returns the same instance on successive calls', async () => {
    // Import fresh to avoid cross-test contamination
    const { getLspRegistry: getA } = await import('./lsp-registry');
    const { getLspRegistry: getB } = await import('./lsp-registry');
    expect(getA()).toBe(getB());
  });

  it('singleton always has built-in definitions', () => {
    const reg = getLspRegistry();
    expect(reg.get('python')).toBeDefined();
    expect(reg.get('julia')).toBeDefined();
  });
});
