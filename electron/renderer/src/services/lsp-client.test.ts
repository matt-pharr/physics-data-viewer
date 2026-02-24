/**
 * Tests for LspClient renderer service
 *
 * We mock the browser WebSocket API and a minimal monaco instance
 * so all logic can be tested in Node/Vitest without a DOM.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LspClient } from './lsp-client';

// ─── Minimal Monaco mock ──────────────────────────────────────────────────────

type MockDisposable = { dispose: () => void };

function makeMockMonaco() {
  const registeredProviders: Record<string, unknown[]> = {};
  const modelMarkers: Record<string, unknown[]> = {};
  const models: Array<{ uri: { toString: () => string } }> = [];

  const addProvider = (language: string, provider: unknown) => {
    (registeredProviders[language] ??= []).push(provider);
    return { dispose: vi.fn() };
  };

  return {
    languages: {
      registerCompletionItemProvider: vi.fn(addProvider) as typeof addProvider,
      registerHoverProvider: vi.fn(addProvider) as typeof addProvider,
      registerSignatureHelpProvider: vi.fn(addProvider) as typeof addProvider,
      registerDefinitionProvider: vi.fn(addProvider) as typeof addProvider,
      CompletionItemKind: {
        Text: 18, Method: 0, Function: 1, Variable: 5, Class: 6,
        Module: 8, Property: 9, Keyword: 14, Snippet: 15,
      },
    },
    editor: {
      getModels: vi.fn(() => models),
      setModelMarkers: vi.fn((model, owner, markers) => {
        const uri = (model as { uri: { toString: () => string } }).uri.toString();
        modelMarkers[`${owner}:${uri}`] = markers;
      }),
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: {
      parse: (s: string) => ({ toString: () => s, _parsed: s }),
    },
    _registeredProviders: registeredProviders,
    _modelMarkers: modelMarkers,
    _models: models,
  };
}

// ─── WebSocket mock factory ───────────────────────────────────────────────────

interface MockWsInstance {
  readyState: number;
  sentMessages: string[];
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: (() => void) | null;
  send: (data: string) => void;
  close: () => void;
  /** Helper: simulate server sending a message to the client */
  simulateReceive: (data: unknown) => void;
  /** Helper: trigger the open event */
  triggerOpen: () => void;
  /** Helper: trigger close */
  triggerClose: () => void;
}

function makeMockWebSocket(): MockWsInstance {
  const ws: MockWsInstance = {
    readyState: 0, // CONNECTING
    sentMessages: [],
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data: string) {
      this.sentMessages.push(data);
    },
    close() {
      this.readyState = 3; // CLOSED
      this.onclose?.();
    },
    simulateReceive(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) });
    },
    triggerOpen() {
      this.readyState = 1; // OPEN
      this.onopen?.();
    },
    triggerClose() {
      this.readyState = 3;
      this.onclose?.();
    },
  };
  return ws;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a connected LspClient with a mocked WebSocket and Monaco.
 * Returns the client, mock WS, and mock Monaco so tests can interact with them.
 */
async function makeConnectedClient(languageId = 'python') {
  const mockWs = makeMockWebSocket();
  const mockMonaco = makeMockMonaco();

  // Replace globalThis.WebSocket with our factory
  const OriginalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = class {
    constructor() { return mockWs; }
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
  };

  const client = new LspClient(languageId);

  // Start connecting (will await the open event)
  const connectPromise = client.connect(9999, mockMonaco as never, '/workspace');

  // Trigger the open event so the WebSocket "connects"
  mockWs.triggerOpen();

  // The initialize request will be sent; respond to it
  await vi.waitFor(() => {
    return mockWs.sentMessages.length > 0;
  });

  // Find and respond to the initialize request
  const initMsg = JSON.parse(mockWs.sentMessages[0]) as { id: number; method: string };
  expect(initMsg.method).toBe('initialize');
  mockWs.simulateReceive({ jsonrpc: '2.0', id: initMsg.id, result: { capabilities: {} } });

  // Wait for connect to resolve
  await connectPromise;

  // Restore WebSocket
  (globalThis as Record<string, unknown>).WebSocket = OriginalWebSocket;

  return { client, mockWs, mockMonaco };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LspClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connect()', () => {
    it('sends an initialize request on connection', async () => {
      const { mockWs } = await makeConnectedClient();
      const initMsg = JSON.parse(mockWs.sentMessages[0]) as { method: string };
      expect(initMsg.method).toBe('initialize');
    });

    it('sends an initialized notification after initialize response', async () => {
      const { mockWs } = await makeConnectedClient();
      const notifications = mockWs.sentMessages
        .map((m) => JSON.parse(m) as { method: string; id?: number })
        .filter((m) => !('id' in m));
      expect(notifications.some((n) => n.method === 'initialized')).toBe(true);
    });

    it('registers all four Monaco providers for the language', async () => {
      const { mockMonaco } = await makeConnectedClient('python');
      expect(mockMonaco.languages.registerCompletionItemProvider).toHaveBeenCalledWith(
        'python',
        expect.objectContaining({ provideCompletionItems: expect.any(Function) }),
      );
      expect(mockMonaco.languages.registerHoverProvider).toHaveBeenCalledWith(
        'python',
        expect.objectContaining({ provideHover: expect.any(Function) }),
      );
      expect(mockMonaco.languages.registerSignatureHelpProvider).toHaveBeenCalledWith(
        'python',
        expect.objectContaining({ provideSignatureHelp: expect.any(Function) }),
      );
      expect(mockMonaco.languages.registerDefinitionProvider).toHaveBeenCalledWith(
        'python',
        expect.objectContaining({ provideDefinition: expect.any(Function) }),
      );
    });

    it('isConnected returns true after successful connect', async () => {
      const { client } = await makeConnectedClient();
      expect(client.isConnected).toBe(true);
    });
  });

  describe('sendRequest()', () => {
    it('sends a JSON-RPC request and resolves with the result', async () => {
      const { client, mockWs } = await makeConnectedClient();

      const requestPromise = client.sendRequest('textDocument/hover', { textDocument: { uri: 'foo' }, position: { line: 0, character: 5 } });

      // Find the hover request
      await vi.waitFor(() => mockWs.sentMessages.length >= 3); // init + initialized + hover
      const hoverMsg = mockWs.sentMessages
        .map((m) => JSON.parse(m) as { id?: number; method: string })
        .find((m) => m.method === 'textDocument/hover')!;

      // Simulate response
      mockWs.simulateReceive({
        jsonrpc: '2.0',
        id: hoverMsg.id,
        result: { contents: 'A hover result' },
      });

      const result = await requestPromise;
      expect((result as { contents: string }).contents).toBe('A hover result');
    });

    it('rejects when the server returns an error response', async () => {
      const { client, mockWs } = await makeConnectedClient();

      const requestPromise = client.sendRequest('textDocument/definition', {});

      await vi.waitFor(() => mockWs.sentMessages.some(
        (m) => (JSON.parse(m) as { method: string }).method === 'textDocument/definition',
      ));

      const defMsg = mockWs.sentMessages
        .map((m) => JSON.parse(m) as { id?: number; method: string })
        .find((m) => m.method === 'textDocument/definition')!;

      mockWs.simulateReceive({
        jsonrpc: '2.0',
        id: defMsg.id,
        error: { code: -32600, message: 'Invalid request' },
      });

      await expect(requestPromise).rejects.toThrow('Invalid request');
    });

    it('times out after 5 seconds with no server response', async () => {
      vi.useFakeTimers();
      const { client } = await makeConnectedClient();

      const requestPromise = client.sendRequest('textDocument/completion', {});
      vi.advanceTimersByTime(5001);

      await expect(requestPromise).rejects.toThrow(/timed out/i);
      vi.useRealTimers();
    });

    it('rejects immediately when WebSocket is not connected', async () => {
      const client = new LspClient('python');
      await expect(client.sendRequest('initialize', {})).rejects.toThrow(/not connected/i);
    });
  });

  describe('sendNotification()', () => {
    it('sends a JSON-RPC notification without an id', async () => {
      const { client, mockWs } = await makeConnectedClient();
      const beforeCount = mockWs.sentMessages.length;

      client.sendNotification('custom/notification', { foo: 'bar' });

      expect(mockWs.sentMessages.length).toBe(beforeCount + 1);
      const msg = JSON.parse(mockWs.sentMessages[mockWs.sentMessages.length - 1]) as {
        method: string; params: unknown; id?: unknown;
      };
      expect(msg.method).toBe('custom/notification');
      expect(msg.params).toEqual({ foo: 'bar' });
      expect('id' in msg).toBe(false);
    });

    it('does not throw when WebSocket is not open', () => {
      const client = new LspClient('python');
      expect(() => client.sendNotification('test/notify', {})).not.toThrow();
    });
  });

  describe('document synchronisation', () => {
    it('openDocument() sends textDocument/didOpen', async () => {
      const { client, mockWs } = await makeConnectedClient();
      const before = mockWs.sentMessages.length;

      client.openDocument('file:///test.py', 'python', 'x = 1\n');

      const msg = JSON.parse(mockWs.sentMessages[before]) as { method: string; params: unknown };
      expect(msg.method).toBe('textDocument/didOpen');
      expect((msg.params as { textDocument: { uri: string } }).textDocument.uri).toBe('file:///test.py');
    });

    it('openDocument() sends didChange instead of didOpen for already-open document', async () => {
      const { client, mockWs } = await makeConnectedClient();
      client.openDocument('file:///test.py', 'python', 'x = 1');

      const beforeCount = mockWs.sentMessages.length;
      client.openDocument('file:///test.py', 'python', 'x = 2');

      const msg = JSON.parse(mockWs.sentMessages[beforeCount]) as { method: string };
      expect(msg.method).toBe('textDocument/didChange');
    });

    it('changeDocument() sends textDocument/didChange', async () => {
      const { client, mockWs } = await makeConnectedClient();
      client.openDocument('file:///test.py', 'python', 'x = 1');
      const before = mockWs.sentMessages.length;

      client.changeDocument('file:///test.py', 'x = 42');

      const msg = JSON.parse(mockWs.sentMessages[before]) as { method: string; params: unknown };
      expect(msg.method).toBe('textDocument/didChange');
      expect(
        ((msg.params as { contentChanges: Array<{ text: string }> }).contentChanges[0]).text,
      ).toBe('x = 42');
    });

    it('changeDocument() is a no-op for a document that was never opened', async () => {
      const { client, mockWs } = await makeConnectedClient();
      const before = mockWs.sentMessages.length;

      client.changeDocument('file:///never-opened.py', 'x = 1');

      expect(mockWs.sentMessages.length).toBe(before); // no new message
    });

    it('closeDocument() sends textDocument/didClose', async () => {
      const { client, mockWs } = await makeConnectedClient();
      client.openDocument('file:///test.py', 'python', '');
      const before = mockWs.sentMessages.length;

      client.closeDocument('file:///test.py');

      const msg = JSON.parse(mockWs.sentMessages[before]) as { method: string; params: unknown };
      expect(msg.method).toBe('textDocument/didClose');
    });

    it('closeDocument() is a no-op for an unopened document', async () => {
      const { client, mockWs } = await makeConnectedClient();
      const before = mockWs.sentMessages.length;

      client.closeDocument('file:///ghost.py');

      expect(mockWs.sentMessages.length).toBe(before);
    });
  });

  describe('textDocument/publishDiagnostics', () => {
    it('sets Monaco markers when a matching model exists', async () => {
      const { client, mockWs, mockMonaco } = await makeConnectedClient('python');

      // Simulate a model matching the document URI
      const uri = 'file:///src/test.py';
      const fakeModel = { uri: { toString: () => uri } };
      mockMonaco._models.push(fakeModel);

      // Simulate diagnostics notification from server
      mockWs.simulateReceive({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              message: 'Undefined variable',
              severity: 1, // Error
              source: 'pylsp',
            },
          ],
        },
      });

      expect(mockMonaco.editor.setModelMarkers).toHaveBeenCalledWith(
        fakeModel,
        'lsp-python',
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Undefined variable',
            severity: 8, // MarkerSeverity.Error
          }),
        ]),
      );
    });

    it('maps all four LSP severity levels to Monaco MarkerSeverity', async () => {
      const { client, mockWs, mockMonaco } = await makeConnectedClient('python');
      const uri = 'file:///diag.py';
      const fakeModel = { uri: { toString: () => uri } };
      mockMonaco._models.push(fakeModel);

      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      mockWs.simulateReceive({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            { range, message: 'error', severity: 1 },
            { range, message: 'warn', severity: 2 },
            { range, message: 'info', severity: 3 },
            { range, message: 'hint', severity: 4 },
          ],
        },
      });

      const lastCall = (mockMonaco.editor.setModelMarkers as ReturnType<typeof vi.fn>).mock.lastCall!;
      const markers = lastCall[2] as Array<{ severity: number }>;
      expect(markers[0].severity).toBe(8); // Error
      expect(markers[1].severity).toBe(4); // Warning
      expect(markers[2].severity).toBe(2); // Info
      expect(markers[3].severity).toBe(1); // Hint
    });

    it('does nothing when no matching model is found', async () => {
      const { client, mockWs, mockMonaco } = await makeConnectedClient('python');
      // No models registered
      mockWs.simulateReceive({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///unknown.py', diagnostics: [] },
      });
      expect(mockMonaco.editor.setModelMarkers).not.toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('closes the WebSocket', async () => {
      const { client, mockWs } = await makeConnectedClient();
      client.dispose();
      expect(mockWs.readyState).toBe(3); // CLOSED
    });

    it('disposes all registered Monaco providers', async () => {
      const { client, mockMonaco } = await makeConnectedClient();
      client.dispose();

      // All dispose() methods from registerXxxProvider should have been called
      const allProviderCalls = [
        ...(mockMonaco.languages.registerCompletionItemProvider as ReturnType<typeof vi.fn>).mock.results,
        ...(mockMonaco.languages.registerHoverProvider as ReturnType<typeof vi.fn>).mock.results,
        ...(mockMonaco.languages.registerSignatureHelpProvider as ReturnType<typeof vi.fn>).mock.results,
        ...(mockMonaco.languages.registerDefinitionProvider as ReturnType<typeof vi.fn>).mock.results,
      ];
      for (const result of allProviderCalls) {
        expect((result.value as MockDisposable).dispose).toHaveBeenCalled();
      }
    });

    it('isConnected returns false after dispose', async () => {
      const { client } = await makeConnectedClient();
      client.dispose();
      expect(client.isConnected).toBe(false);
    });

    it('pending requests are rejected on close', async () => {
      const { client, mockWs } = await makeConnectedClient();

      const requestPromise = client.sendRequest('textDocument/hover', {});

      // Simulate server closing the connection before responding
      mockWs.triggerClose();

      await expect(requestPromise).rejects.toThrow(/closed/i);
    });
  });

  describe('initialize capabilities', () => {
    it('initialize request contains expected client capabilities', async () => {
      const { mockWs } = await makeConnectedClient();
      const initMsg = JSON.parse(mockWs.sentMessages[0]) as {
        params: {
          capabilities: {
            textDocument: {
              completion: unknown;
              hover: unknown;
              signatureHelp: unknown;
              definition: unknown;
              publishDiagnostics: unknown;
            };
          };
        };
      };
      const caps = initMsg.params.capabilities.textDocument;
      expect(caps.completion).toBeDefined();
      expect(caps.hover).toBeDefined();
      expect(caps.signatureHelp).toBeDefined();
      expect(caps.definition).toBeDefined();
      expect(caps.publishDiagnostics).toBeDefined();
    });

    it('initialize request includes workspaceFolders', async () => {
      const { mockWs } = await makeConnectedClient();
      const initMsg = JSON.parse(mockWs.sentMessages[0]) as {
        params: { workspaceFolders: Array<{ uri: string }> };
      };
      expect(Array.isArray(initMsg.params.workspaceFolders)).toBe(true);
      expect(initMsg.params.workspaceFolders.length).toBeGreaterThan(0);
    });
  });
});
