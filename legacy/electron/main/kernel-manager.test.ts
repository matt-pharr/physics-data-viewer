/**
 * KernelManager Unit Tests
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { KernelManager, getKernelManager, resetKernelManager, parseMessage, serializeMessage, safeJsonParse } from './kernel-manager';

const hasRealKernel = process.env.PDV_ENABLE_REAL_KERNEL_TESTS === 'true' && process.env.CI !== 'true';
const realIt = hasRealKernel ? it : it.skip;

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeFrames(key: string, headerOverride?: object) {
  const header = { msg_id: 'test-id', username: 'pdv', session: 'sess', msg_type: 'status', version: '5.3', date: new Date().toISOString(), ...headerOverride };
  const parentHeader = {};
  const metadata = {};
  const content = { execution_state: 'idle' };

  const hBuf = Buffer.from(JSON.stringify(header));
  const phBuf = Buffer.from(JSON.stringify(parentHeader));
  const mBuf = Buffer.from(JSON.stringify(metadata));
  const cBuf = Buffer.from(JSON.stringify(content));

  const hmac = crypto.createHmac('sha256', key);
  hmac.update(hBuf);
  hmac.update(phBuf);
  hmac.update(mBuf);
  hmac.update(cBuf);
  const sig = hmac.digest('hex');

  return [Buffer.from('<IDS|MSG>'), Buffer.from(sig), hBuf, phBuf, mBuf, cBuf];
}

// ─── safeJsonParse ────────────────────────────────────────────────────────────

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(safeJsonParse('not-json')).toBeNull();
  });

  it('returns null when payload exceeds maxSize', () => {
    const huge = 'x'.repeat(100);
    expect(safeJsonParse(huge, 10)).toBeNull();
  });

  it('accepts Buffer input', () => {
    expect(safeJsonParse(Buffer.from('"hello"'))).toBe('hello');
  });
});

// ─── parseMessage / HMAC validation ──────────────────────────────────────────

describe('parseMessage', () => {
  const key = crypto.randomUUID();

  it('parses a correctly signed message', () => {
    const frames = makeFrames(key);
    const msg = parseMessage(frames, key);
    expect(msg).not.toBeNull();
    expect(msg?.header.msg_type).toBe('status');
  });

  it('rejects a message with a wrong key', () => {
    const frames = makeFrames(key);
    const msg = parseMessage(frames, 'wrong-key');
    expect(msg).toBeNull();
  });

  it('rejects a message with a tampered frame', () => {
    const frames = makeFrames(key);
    // Tamper with the content frame
    frames[5] = Buffer.from(JSON.stringify({ execution_state: 'hacked' }));
    const msg = parseMessage(frames, key);
    expect(msg).toBeNull();
  });

  it('returns null when delimiter is missing', () => {
    const frames = [Buffer.from('no-delimiter')];
    expect(parseMessage(frames, key)).toBeNull();
  });

  it('returns null when too few frames follow delimiter', () => {
    const frames = [Buffer.from('<IDS|MSG>'), Buffer.from('sig')]; // only 2 after delimiter
    expect(parseMessage(frames, key)).toBeNull();
  });

  it('round-trips via serializeMessage', () => {
    const session = crypto.randomUUID();
    const msg = { header: { msg_id: 'x', username: 'u', session, msg_type: 'execute_reply', version: '5.3', date: '' }, parent_header: {}, metadata: {}, content: { status: 'ok' } };
    const frames = serializeMessage(msg, key);
    const parsed = parseMessage(frames, key);
    expect(parsed?.header.msg_type).toBe('execute_reply');
    expect((parsed?.content as any).status).toBe('ok');
  });
});

// ─── KernelManager API ────────────────────────────────────────────────────────

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

  it('execute returns error for non-existent kernel', async () => {
    const result = await manager.execute('no-such-id', { code: 'x' });
    expect(result.error).toMatch(/Kernel not found/);
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
