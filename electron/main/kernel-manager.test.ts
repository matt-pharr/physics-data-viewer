/**
 * KernelManager Unit Tests
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelManager, getKernelManager, resetKernelManager } from './kernel-manager';

const hasRealKernel = process.env.PDV_ENABLE_REAL_KERNEL_TESTS === 'true' && process.env.CI !== 'true';
const realIt = hasRealKernel ? it : it.skip;

describe('KernelManager', () => {
  let manager: KernelManager;

  beforeEach(() => {
    resetKernelManager();
    manager = new KernelManager();
  });

  afterEach(() => {
    resetKernelManager();
  });

  it('should start with no kernels', async () => {
    const kernels = await manager.list();
    expect(kernels).toHaveLength(0);
  });

  it('should handle stopping non-existent kernel', async () => {
    const stopped = await manager.stop('non-existent');
    expect(stopped).toBe(false);
  });

  describe('Real kernels (skipped when unavailable)', () => {
    realIt('starts a real Python kernel', async () => {
      const kernel = await manager.start({ language: 'python' });
      expect(kernel.id).toBeDefined();
      expect(kernel.status === 'idle' || kernel.status === 'busy').toBe(true);
      await manager.stop(kernel.id);
    });

    realIt('executes real Python code', async () => {
      const kernel = await manager.start({ language: 'python' });
      const result = await manager.execute(kernel.id, { code: 'print("real!")' });

      expect(result.error).toBeUndefined();
      expect(result.stdout?.includes('real!')).toBe(true);

      await manager.stop(kernel.id);
    });
  });

  describe('Singleton', () => {
    it('should return same instance from getKernelManager', () => {
      const instance1 = getKernelManager();
      const instance2 = getKernelManager();
      expect(instance1).toBe(instance2);
    });
  });
});
