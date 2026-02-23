import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KernelInfo } from './ipc';
import { getPythonFirstScriptCompatibilityError, normalizeWatchPath, pickKernelForScriptReload, validateFilePath } from './index';

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
