/**
 * KernelManager Unit Tests
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelManager, getKernelManager, resetKernelManager } from './kernel-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

    realIt('creates and runs a script from the tree', async () => {
      // Start a Python kernel
      const kernel = await manager.start({ language: 'python' });
      
      // Get the tree root path
      const { loadConfig } = await import('./config');
      const config = loadConfig();
      const treeRoot = config.treeRoot || path.join(config.projectRoot || config.cwd || process.cwd(), 'tree');
      const scriptsDir = path.join(treeRoot, 'scripts');
      
      // Create scripts directory if it doesn't exist
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }
      
      // Create a test script
      const scriptPath = path.join(scriptsDir, 'test_script.py');
      const scriptContent = `"""Test script for unit testing"""

def run(tree, **kwargs):
    return {"status": "success", "message": "Script executed successfully", "params": kwargs}
`;
      fs.writeFileSync(scriptPath, scriptContent);
      
      try {
        // Execute the script using tree.run_script
        const code = 'tree.run_script("scripts.test_script", param1="value1", param2=42)';
        const result = await manager.execute(kernel.id, { code });
        
        expect(result.error).toBeUndefined();
        expect(result.result).toBeDefined();
        
        // Check the result contains expected data
        const resultObj = result.result as any;
        expect(resultObj.status).toBe('success');
        expect(resultObj.message).toBe('Script executed successfully');
        expect(resultObj.params).toEqual({ param1: 'value1', param2: 42 });
      } finally {
        // Clean up
        if (fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath);
        }
        await manager.stop(kernel.id);
      }
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
