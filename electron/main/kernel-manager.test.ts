/**
 * KernelManager Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KernelManager, getKernelManager, resetKernelManager } from './kernel-manager';

describe('KernelManager', () => {
  let manager: KernelManager;

  beforeEach(() => {
    resetKernelManager();
    manager = new KernelManager();
  });

  afterEach(() => {
    resetKernelManager();
  });

  describe('Kernel Lifecycle', () => {
    it('should start with no kernels', async () => {
      const kernels = await manager.list();
      expect(kernels).toHaveLength(0);
    });

    it('should start a Python kernel', async () => {
      const kernel = await manager.start({ language: 'python' });

      expect(kernel.id).toBeDefined();
      expect(kernel.language).toBe('python');
      expect(kernel.status).toBe('idle');

      const kernels = await manager.list();
      expect(kernels).toHaveLength(1);
    });

    it('should start a Julia kernel', async () => {
      const kernel = await manager.start({ language: 'julia' });

      expect(kernel.id).toBeDefined();
      expect(kernel.language).toBe('julia');
      expect(kernel.status).toBe('idle');
    });

    it('should stop a kernel', async () => {
      const kernel = await manager.start();
      expect(await manager.list()).toHaveLength(1);

      const stopped = await manager.stop(kernel.id);
      expect(stopped).toBe(true);
      expect(await manager.list()).toHaveLength(0);
    });

    it('should restart a kernel', async () => {
      const kernel = await manager.start();
      const originalId = kernel.id;

      const restarted = await manager.restart(kernel.id);
      expect(restarted.id).toBe(originalId);
      expect(restarted.status).toBe('idle');
    });

    it('should handle stopping non-existent kernel', async () => {
      const stopped = await manager.stop('non-existent');
      expect(stopped).toBe(false);
    });

    it('should throw when restarting non-existent kernel', async () => {
      await expect(manager.restart('non-existent')).rejects.toThrow();
    });
  });

  describe('Code Execution', () => {
    it('should execute simple code', async () => {
      const kernel = await manager.start();
      const result = await manager.execute(kernel.id, { code: 'print("hello")' });

      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('hello');
      expect(result.duration).toBeDefined();
    });

    it('should evaluate expressions', async () => {
      const kernel = await manager.start();
      const result = await manager.execute(kernel.id, { code: '1 + 1' });

      expect(result.error).toBeUndefined();
      expect(result.result).toBe(2);
    });

    it('should return error for non-existent kernel', async () => {
      const result = await manager.execute('non-existent', { code: 'test' });
      expect(result.error).toBeDefined();
    });

    it('should handle capture mode', async () => {
      const kernel = await manager.start();
      const result = await manager.execute(kernel.id, {
        code: 'plt.show()',
        capture: true,
      });

      // Stub returns image data when capture is true and code contains plt.show
      expect(result.images).toBeDefined();
    });
  });

  describe('Completions', () => {
    it('should return Python completions', async () => {
      const kernel = await manager.start({ language: 'python' });
      const result = await manager.complete(kernel.id, 'pri', 3);

      expect(result.matches).toContain('print');
      expect(result.cursor_start).toBe(0);
      expect(result.cursor_end).toBe(3);
    });

    it('should return Julia completions', async () => {
      const kernel = await manager.start({ language: 'julia' });
      const result = await manager.complete(kernel.id, 'print', 5);

      expect(result.matches).toContain('println');
    });

    it('should return empty for non-existent kernel', async () => {
      const result = await manager.complete('non-existent', 'test', 4);
      expect(result.matches).toHaveLength(0);
    });
  });

  describe('Inspection', () => {
    it('should return docs for known functions', async () => {
      const kernel = await manager.start({ language: 'python' });
      const result = await manager.inspect(kernel.id, 'print', 5);

      expect(result.found).toBe(true);
      expect(result.data?.['text/plain']).toContain('print');
    });

    it('should return not found for unknown items', async () => {
      const kernel = await manager.start();
      const result = await manager.inspect(kernel.id, 'unknown_variable', 15);

      expect(result.found).toBe(false);
    });
  });

  describe('Singleton', () => {
    it('should return same instance from getKernelManager', () => {
      const instance1 = getKernelManager();
      const instance2 = getKernelManager();
      expect(instance1).toBe(instance2);
    });

    it('should reset singleton with resetKernelManager', async () => {
      const instance1 = getKernelManager();
      await instance1.start();
      expect(await instance1.list()).toHaveLength(1);

      resetKernelManager();

      const instance2 = getKernelManager();
      expect(instance2).not.toBe(instance1);
      expect(await instance2.list()).toHaveLength(0);
    });
  });
});
