import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KernelInfo } from './ipc';
import {
  getPythonFirstScriptCompatibilityError,
  normalizeWatchPath,
  pickKernelForScriptReload,
  validateFilePath,
  sanitizeScriptName,
  parseDefaultValue,
} from './index';

// ─── pickKernelForScriptReload ────────────────────────────────────────────────

describe('index helper utilities', () => {
  it('pickKernelForScriptReload prefers requested language when present', () => {
    const kernels: KernelInfo[] = [
      { id: '1', name: 'python3', language: 'python', status: 'idle' },
      { id: '2', name: 'julia', language: 'julia', status: 'idle' },
    ];
    expect(pickKernelForScriptReload(kernels, 'julia')?.id).toBe('2');
  });

  it('pickKernelForScriptReload falls back to first kernel if preferred missing', () => {
    const kernels: KernelInfo[] = [
      { id: '1', name: 'python3', language: 'python', status: 'idle' },
    ];
    expect(pickKernelForScriptReload(kernels, 'julia')?.id).toBe('1');
  });

  it('pickKernelForScriptReload returns null for empty array', () => {
    expect(pickKernelForScriptReload([])).toBeNull();
  });

  it('pickKernelForScriptReload returns null for non-array input', () => {
    expect(pickKernelForScriptReload(null as any)).toBeNull();
  });

  it('pickKernelForScriptReload returns first when no preference given', () => {
    const kernels: KernelInfo[] = [
      { id: '1', name: 'python3', language: 'python', status: 'idle' },
      { id: '2', name: 'julia', language: 'julia', status: 'idle' },
    ];
    expect(pickKernelForScriptReload(kernels)?.id).toBe('1');
  });

  it('normalizeWatchPath returns resolved path only for existing path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-watch-'));
    try {
      expect(normalizeWatchPath(tempDir)).toBe(path.resolve(tempDir));
      expect(normalizeWatchPath(path.join(tempDir, 'missing'))).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizeWatchPath rejects non-string input', () => {
    expect(normalizeWatchPath(null as any)).toBeNull();
    expect(normalizeWatchPath(42 as any)).toBeNull();
  });

  it('normalizeWatchPath rejects path with control characters', () => {
    expect(normalizeWatchPath('/tmp/foo\x00bar')).toBeNull();
    expect(normalizeWatchPath('/tmp/foo\x1Fbar')).toBeNull();
  });

  it('normalizeWatchPath rejects empty string', () => {
    expect(normalizeWatchPath('')).toBeNull();
    expect(normalizeWatchPath('   ')).toBeNull();
  });

  it('getPythonFirstScriptCompatibilityError blocks julia script with python-only policy', () => {
    expect(getPythonFirstScriptCompatibilityError('julia', 'python')).toContain('Julia scripts are not yet supported');
  });

  it('getPythonFirstScriptCompatibilityError blocks julia kernel with python-only policy', () => {
    expect(getPythonFirstScriptCompatibilityError('python', 'julia')).toContain('Julia kernel execution is not yet supported');
  });

  it('getPythonFirstScriptCompatibilityError allows python script on python kernel', () => {
    expect(getPythonFirstScriptCompatibilityError('python', 'python')).toBeNull();
  });
});

// ─── validateFilePath ─────────────────────────────────────────────────────────

describe('validateFilePath', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-root-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('accepts a path inside the allowed root', () => {
    const target = path.join(tempRoot, 'scripts', 'myscript.py');
    expect(validateFilePath(target, tempRoot)).toBe(path.resolve(target));
  });

  it('accepts the root itself', () => {
    expect(validateFilePath(tempRoot, tempRoot)).toBe(path.resolve(tempRoot));
  });

  it('rejects a path that traverses above the root', () => {
    const traversal = path.join(tempRoot, '..', 'etc', 'passwd');
    expect(validateFilePath(traversal, tempRoot)).toBeNull();
  });

  it('rejects an absolute path outside the root', () => {
    expect(validateFilePath('/etc/passwd', tempRoot)).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateFilePath('', tempRoot)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(validateFilePath(null as any, tempRoot)).toBeNull();
  });

  it('rejects encoded traversal (../../)', () => {
    expect(validateFilePath(tempRoot + '/foo/../../etc/passwd', tempRoot)).toBeNull();
  });
});

// ─── sanitizeScriptName ───────────────────────────────────────────────────────

describe('sanitizeScriptName', () => {
  it('returns null for empty string', () => {
    expect(sanitizeScriptName('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(sanitizeScriptName('   ')).toBeNull();
  });

  it('allows simple alphanumeric names', () => {
    expect(sanitizeScriptName('my_analysis')).toBe('my_analysis');
  });

  it('converts spaces to underscores', () => {
    expect(sanitizeScriptName('my analysis')).toBe('my_analysis');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeScriptName('  my_script  ')).toBe('my_script');
  });

  it('rejects names containing forward slash', () => {
    expect(sanitizeScriptName('scripts/evil')).toBeNull();
  });

  it('rejects names containing backslash', () => {
    expect(sanitizeScriptName('scripts\\evil')).toBeNull();
  });

  it('rejects names containing special shell characters', () => {
    expect(sanitizeScriptName('foo<bar')).toBeNull();
    expect(sanitizeScriptName('foo>bar')).toBeNull();
    expect(sanitizeScriptName('foo|bar')).toBeNull();
    expect(sanitizeScriptName('foo?bar')).toBeNull();
    expect(sanitizeScriptName('foo*bar')).toBeNull();
  });

  it('rejects names longer than 200 characters', () => {
    expect(sanitizeScriptName('a'.repeat(201))).toBeNull();
  });

  it('accepts names at exactly 200 characters', () => {
    const name = 'a'.repeat(200);
    expect(sanitizeScriptName(name)).toBe(name);
  });

  it('allows dots and dashes', () => {
    expect(sanitizeScriptName('my-script.v2')).toBe('my-script.v2');
  });

  it('rejects unicode characters not in the allowed set', () => {
    expect(sanitizeScriptName('analyse_données')).toBeNull();
  });
});

// ─── parseDefaultValue ────────────────────────────────────────────────────────

describe('parseDefaultValue', () => {
  it('parses Python True as boolean true', () => {
    expect(parseDefaultValue('True')).toBe(true);
    expect(parseDefaultValue('true')).toBe(true);
  });

  it('parses Python False as boolean false', () => {
    expect(parseDefaultValue('False')).toBe(false);
    expect(parseDefaultValue('false')).toBe(false);
  });

  it('parses integer strings as numbers', () => {
    expect(parseDefaultValue('42')).toBe(42);
    expect(parseDefaultValue('-7')).toBe(-7);
    expect(parseDefaultValue('0')).toBe(0);
  });

  it('parses float strings as numbers', () => {
    expect(parseDefaultValue('3.14')).toBe(3.14);
    expect(parseDefaultValue('-0.5')).toBe(-0.5);
  });

  it('strips double quotes from string literals', () => {
    expect(parseDefaultValue('"hello"')).toBe('hello');
  });

  it('strips single quotes from string literals', () => {
    expect(parseDefaultValue("'world'")).toBe('world');
  });

  it('returns unquoted bare strings as-is (trimmed)', () => {
    expect(parseDefaultValue('  myvalue  ')).toBe('myvalue');
  });

  it('handles whitespace around values', () => {
    expect(parseDefaultValue('  42  ')).toBe(42);
    expect(parseDefaultValue('  True  ')).toBe(true);
  });
});

describe('index helper utilities', () => {
  it('pickKernelForScriptReload prefers requested language when present', () => {
    const kernels: KernelInfo[] = [
      { id: '1', name: 'python3', language: 'python', status: 'idle' },
      { id: '2', name: 'julia', language: 'julia', status: 'idle' },
    ];

    const selected = pickKernelForScriptReload(kernels, 'julia');
    expect(selected?.id).toBe('2');
  });

  it('pickKernelForScriptReload falls back to first kernel if preferred missing', () => {
    const kernels: KernelInfo[] = [
      { id: '1', name: 'python3', language: 'python', status: 'idle' },
    ];

    const selected = pickKernelForScriptReload(kernels, 'julia');
    expect(selected?.id).toBe('1');
  });

  it('normalizeWatchPath returns resolved path only for existing path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-watch-'));
    try {
      const normalized = normalizeWatchPath(tempDir);
      expect(normalized).toBe(path.resolve(tempDir));

      expect(normalizeWatchPath(path.join(tempDir, 'missing'))).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('getPythonFirstScriptCompatibilityError blocks julia script with python-only policy', () => {
    expect(getPythonFirstScriptCompatibilityError('julia', 'python')).toContain('Julia scripts are not yet supported');
  });

  it('getPythonFirstScriptCompatibilityError blocks julia kernel with python-only policy', () => {
    expect(getPythonFirstScriptCompatibilityError('python', 'julia')).toContain('Julia kernel execution is not yet supported');
  });

  it('getPythonFirstScriptCompatibilityError allows python script on python kernel', () => {
    expect(getPythonFirstScriptCompatibilityError('python', 'python')).toBeNull();
  });
});

// ─── validateFilePath ─────────────────────────────────────────────────────────

describe('validateFilePath', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-root-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('accepts a path inside the allowed root', () => {
    const target = path.join(tempRoot, 'scripts', 'myscript.py');
    const result = validateFilePath(target, tempRoot);
    expect(result).toBe(path.resolve(target));
  });

  it('accepts the root itself', () => {
    expect(validateFilePath(tempRoot, tempRoot)).toBe(path.resolve(tempRoot));
  });

  it('rejects a path that traverses above the root', () => {
    const traversal = path.join(tempRoot, '..', 'etc', 'passwd');
    expect(validateFilePath(traversal, tempRoot)).toBeNull();
  });

  it('rejects an absolute path outside the root', () => {
    expect(validateFilePath('/etc/passwd', tempRoot)).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateFilePath('', tempRoot)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(validateFilePath(null as any, tempRoot)).toBeNull();
  });

  it('rejects encoded traversal (../../)', () => {
    const traversal = tempRoot + '/foo/../../etc/passwd';
    expect(validateFilePath(traversal, tempRoot)).toBeNull();
  });
});
