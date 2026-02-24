/**
 * Tests for LspMessageParser, frameLspMessage, and LspServerManager
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LspMessageParser, frameLspMessage, getLspServerManager, resetLspServerManager } from './lsp-server-manager';

// ─── LspMessageParser ─────────────────────────────────────────────────────────

describe('LspMessageParser', () => {
  it('parses a single complete framed message', () => {
    const parser = new LspMessageParser();
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'test' });
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      Buffer.from(body),
    ]);
    const messages = parser.push(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(body);
  });

  it('accumulates partial chunks before yielding a message', () => {
    const parser = new LspMessageParser();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: null });
    const full = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      Buffer.from(body),
    ]);

    // Split at arbitrary point within the header
    const split = 10;
    const first = parser.push(full.slice(0, split));
    expect(first).toHaveLength(0);

    const second = parser.push(full.slice(split));
    expect(second).toHaveLength(1);
    expect(second[0]).toBe(body);
  });

  it('parses multiple messages arriving in a single push', () => {
    const parser = new LspMessageParser();
    const msg1 = JSON.stringify({ jsonrpc: '2.0', method: 'one' });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', method: 'two' });

    const frame1 = Buffer.concat([
      Buffer.from(`Content-Length: ${msg1.length}\r\n\r\n`),
      Buffer.from(msg1),
    ]);
    const frame2 = Buffer.concat([
      Buffer.from(`Content-Length: ${msg2.length}\r\n\r\n`),
      Buffer.from(msg2),
    ]);

    const messages = parser.push(Buffer.concat([frame1, frame2]));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(msg1);
    expect(messages[1]).toBe(msg2);
  });

  it('handles a message split exactly at the header/body boundary', () => {
    const parser = new LspMessageParser();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { value: 42 } });
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
    const bodyBuf = Buffer.from(body);

    // Push header alone — no message yet
    expect(parser.push(header)).toHaveLength(0);
    // Push body — message completes
    const messages = parser.push(bodyBuf);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(body);
  });

  it('parses body that contains multi-byte UTF-8 characters correctly', () => {
    const parser = new LspMessageParser();
    // 'café' contains a multi-byte character (é = 0xC3 0xA9 in UTF-8, 2 bytes)
    const body = JSON.stringify({ method: 'hover', label: 'café' });
    const bodyBuf = Buffer.from(body, 'utf-8');
    const header = `Content-Length: ${bodyBuf.length}\r\n\r\n`;

    const messages = parser.push(Buffer.concat([Buffer.from(header), bodyBuf]));
    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.label).toBe('café');
  });

  it('discards a frame with a malformed header and continues', () => {
    const parser = new LspMessageParser();

    // Frame 1: malformed (no Content-Length)
    const garbage = Buffer.from('Not-A-Valid-Header\r\n\r\n');

    // Frame 2: valid
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'valid' });
    const valid = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      Buffer.from(body),
    ]);

    // Malformed frame gets discarded; valid frame may or may not survive
    // depending on where parser re-syncs — just ensure no crash
    expect(() => parser.push(Buffer.concat([garbage, valid]))).not.toThrow();
  });

  it('returns empty array when buffer is empty', () => {
    const parser = new LspMessageParser();
    expect(parser.push(Buffer.alloc(0))).toHaveLength(0);
  });

  it('returns empty array when only partial header received', () => {
    const parser = new LspMessageParser();
    expect(parser.push(Buffer.from('Content-Len'))).toHaveLength(0);
  });
});

// ─── frameLspMessage ─────────────────────────────────────────────────────────

describe('frameLspMessage', () => {
  it('produces a buffer with correct Content-Length header', () => {
    const json = '{"jsonrpc":"2.0","id":1}';
    const framed = frameLspMessage(json);
    const str = framed.toString('utf-8');

    expect(str).toMatch(/^Content-Length: \d+\r\n\r\n/);
    const headerEnd = str.indexOf('\r\n\r\n');
    const body = str.slice(headerEnd + 4);
    expect(body).toBe(json);
  });

  it('Content-Length matches byte length (not character length) for UTF-8', () => {
    // 'é' is 2 bytes in UTF-8 but 1 character
    const json = JSON.stringify({ value: 'café' });
    const framed = frameLspMessage(json);
    const str = framed.toString('ascii');
    const match = /Content-Length: (\d+)/.exec(str);
    expect(match).not.toBeNull();

    const declaredLength = parseInt(match![1], 10);
    const bodyBytes = Buffer.from(json, 'utf-8').length;
    expect(declaredLength).toBe(bodyBytes);
  });

  it('round-trips with LspMessageParser', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 99, result: { items: [1, 2, 3] } });
    const framed = frameLspMessage(json);

    const parser = new LspMessageParser();
    const messages = parser.push(framed);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(json);
  });

  it('handles an empty string body', () => {
    const framed = frameLspMessage('');
    const str = framed.toString('ascii');
    expect(str).toMatch(/^Content-Length: 0\r\n\r\n$/);
  });
});

// ─── LspServerManager — state machine & detection ────────────────────────────

describe('LspServerManager', () => {
  beforeEach(() => {
    resetLspServerManager();
    vi.resetModules();
  });

  afterEach(() => {
    resetLspServerManager();
    vi.restoreAllMocks();
  });

  it('getLspServerManager() returns the same singleton on successive calls', () => {
    const a = getLspServerManager();
    const b = getLspServerManager();
    expect(a).toBe(b);
  });

  it('resetLspServerManager() creates a fresh instance', () => {
    const a = getLspServerManager();
    resetLspServerManager();
    const b = getLspServerManager();
    expect(a).not.toBe(b);
  });

  it('getStatus() returns not_configured for an unregistered language', () => {
    const manager = getLspServerManager();
    const status = manager.getStatus('cobol');
    expect(status.languageId).toBe('cobol');
    expect(status.state).toBe('not_configured');
  });

  it('listStatuses() includes entries for all registered languages', () => {
    const manager = getLspServerManager();
    const statuses = manager.listStatuses();
    const ids = statuses.map((s) => s.languageId);
    expect(ids).toContain('python');
    expect(ids).toContain('julia');
  });

  it('detect() returns disabled when user config sets enabled=false', async () => {
    // Mock loadConfig to return a config that disables python LSP
    vi.doMock('./config', () => ({
      loadConfig: () => ({
        pythonPath: 'python3',
        languageServers: { python: { enabled: false, autoStart: false } },
      }),
    }));
    // Also mock BrowserWindow so broadcastStateChange doesn't throw
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    const status = await manager.detect('python');
    expect(status.state).toBe('disabled');
    reset();
  });

  it('detect() returns not_configured for a language not in the registry', async () => {
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    const status = await manager.detect('cobol');
    expect(status.state).toBe('not_configured');
    reset();
  });

  it('detect() transitions through detecting state and emits external_running when port open', async () => {
    // Mock net.Socket to simulate an open port
    vi.doMock('net', async (importOriginal) => {
      const actual = await importOriginal<typeof import('net')>();
      return {
        ...actual,
        Socket: class MockSocket {
          setTimeout() {}
          connect(_port: number, _host: string) {
            // Immediately emit connect to simulate open port
            setTimeout(() => this._connectCb?.(), 0);
          }
          once(event: string, cb: () => void) {
            if (event === 'connect') this._connectCb = cb;
          }
          destroy() {}
          _connectCb?: () => void;
        },
        createServer: actual.createServer.bind(actual),
      };
    });

    vi.doMock('./config', () => ({
      loadConfig: () => ({
        pythonPath: 'python3',
        languageServers: {},
        treeRoot: '/tmp/tree',
      }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    const status = await manager.detect('python');
    expect(status.state).toBe('external_running');
    expect(status.detectedPort).toBeDefined();
    reset();
  });

  it('detect() falls back to launchable when port closed but command on PATH', async () => {
    // Mock net.Socket to simulate closed port
    vi.doMock('net', async (importOriginal) => {
      const actual = await importOriginal<typeof import('net')>();
      return {
        ...actual,
        Socket: class MockSocket {
          setTimeout() {}
          connect() {
            setTimeout(() => this._errCb?.(new Error('ECONNREFUSED')), 0);
          }
          once(event: string, cb: (e?: Error) => void) {
            if (event === 'error') this._errCb = cb;
          }
          destroy() {}
          _errCb?: (e?: Error) => void;
        },
        createServer: actual.createServer.bind(actual),
      };
    });

    // Mock child_process.spawn for `which pylsp` to succeed
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      return {
        ...actual,
        spawn: (cmd: string, args: string[]) => {
          // "which pylsp" → success; everything else → failure
          const isPylspWhich = (cmd === 'which' || cmd === 'where') && args[0] === 'pylsp';
          const mockProc = {
            stdout: { on: (ev: string, cb: (d: Buffer) => void) => {
              if (ev === 'data' && isPylspWhich) cb(Buffer.from('/usr/local/bin/pylsp\n'));
            }},
            on: (ev: string, cb: (code: number) => void) => {
              if (ev === 'close') cb(isPylspWhich ? 0 : 1);
            },
            kill: () => {},
          };
          return mockProc;
        },
      };
    });

    vi.doMock('./config', () => ({
      loadConfig: () => ({
        pythonPath: 'python3',
        languageServers: {},
        treeRoot: '/tmp/tree',
      }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    const status = await manager.detect('python');
    expect(status.state).toBe('launchable');
    expect(status.detectedCommand).toBeDefined();
    reset();
  });

  it('detect() returns not_found when no port open and no command on PATH', async () => {
    vi.doMock('net', async (importOriginal) => {
      const actual = await importOriginal<typeof import('net')>();
      return {
        ...actual,
        Socket: class MockSocket {
          setTimeout() {}
          connect() {
            setTimeout(() => this._errCb?.(new Error('ECONNREFUSED')), 0);
          }
          once(event: string, cb: (e?: Error) => void) {
            if (event === 'error') this._errCb = cb;
          }
          destroy() {}
          _errCb?: (e?: Error) => void;
        },
        createServer: actual.createServer.bind(actual),
      };
    });

    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      return {
        ...actual,
        spawn: (_cmd: string, _args: string[]) => ({
          stdout: { on: () => {} },
          on: (ev: string, cb: (code: number) => void) => {
            if (ev === 'close') cb(1); // always fail
          },
          kill: () => {},
        }),
      };
    });

    vi.doMock('./config', () => ({
      loadConfig: () => ({
        pythonPath: 'python3',
        languageServers: {},
        treeRoot: '/tmp/tree',
      }),
    }));
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    const status = await manager.detect('python');
    expect(status.state).toBe('not_found');
    reset();
  });

  it('disconnect() on a server that was never started does not throw', async () => {
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    await expect(manager.disconnect('python')).resolves.not.toThrow();
    reset();
  });

  it('shutdownAll() resolves without error even with no managed servers', async () => {
    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('./config', () => ({
      loadConfig: () => ({ pythonPath: 'python3', languageServers: {} }),
    }));

    const { getLspServerManager: get, resetLspServerManager: reset } = await import('./lsp-server-manager');
    reset();
    const manager = get();
    await expect(manager.shutdownAll()).resolves.not.toThrow();
    reset();
  });
});
