import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KernelInfo } from './ipc';
import { getPythonFirstScriptCompatibilityError, normalizeWatchPath, pickKernelForScriptReload } from './index';

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
