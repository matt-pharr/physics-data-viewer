/**
 * LSP Client Service
 *
 * Connects to a language server via the main-process WebSocket proxy and
 * registers Monaco editor providers (completions, hover, diagnostics,
 * signature help, go-to-definition).
 *
 * Usage:
 *   const client = new LspClient('python');
 *   await client.connect(proxyPort, monacoInstance, workspaceRoot);
 *   // later:
 *   client.dispose();
 */

import type * as monaco from 'monaco-editor';

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── LSP position/range utilities ────────────────────────────────────────────

function monacoToLspPosition(position: monaco.Position): { line: number; character: number } {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function lspToMonacoRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// ─── Completion kind mapping ──────────────────────────────────────────────────

const LSP_KIND_TO_MONACO: Record<number, monaco.languages.CompletionItemKind> = {
  1: 18,  // Text → Text
  2: 0,   // Method → Method
  3: 1,   // Function → Function
  4: 0,   // Constructor → Method (closest)
  5: 3,   // Field → Field
  6: 5,   // Variable → Variable
  7: 6,   // Class → Class
  8: 7,   // Interface → Interface
  9: 8,   // Module → Module
  10: 9,  // Property → Property
  11: 11, // Unit → Unit
  12: 12, // Value → Value
  13: 13, // Enum → Enum
  14: 14, // Keyword → Keyword
  15: 15, // Snippet → Snippet
  16: 16, // Color → Color
  17: 16, // File → File
  18: 17, // Reference → Reference
  19: 18, // Folder → Folder
  20: 19, // EnumMember → EnumMember
  21: 20, // Constant → Constant
  22: 6,  // Struct → Struct (closest: Class)
  23: 22, // Event → Event
  24: 22, // Operator → Operator
  25: 24, // TypeParameter → TypeParameter
};

// ─── WebSocket readyState constants (spec-defined, safe to use without the global) ──
const WS_OPEN = 1;

// ─── LspClient ───────────────────────────────────────────────────────────────

export class LspClient {
  private languageId: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private notificationHandlers = new Map<string, ((params: unknown) => void)[]>();
  private disposables: monaco.IDisposable[] = [];
  private openDocuments = new Set<string>();
  private diagnosticsOwner: string;
  private monacoRef: typeof monaco | null = null;

  constructor(languageId: string) {
    this.languageId = languageId;
    this.diagnosticsOwner = `lsp-${languageId}`;
  }

  // ── Connection ──────────────────────────────────────────────────────────

  async connect(
    proxyPort: number,
    monacoInstance: typeof monaco,
    workspaceRoot: string,
  ): Promise<void> {
    this.monacoRef = monacoInstance;
    this.ws = new WebSocket(`ws://127.0.0.1:${proxyPort}`);

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = (e) => reject(new Error(`WebSocket error connecting to LSP proxy: ${String(e)}`));
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as JsonRpcMessage;
        this.handleMessage(msg);
      } catch (e) {
        console.error('[lsp-client] Failed to parse message:', e);
      }
    };

    this.ws.onclose = () => {
      console.log(`[lsp-client] Connection to ${this.languageId} server closed`);
      // Reject any pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('LSP connection closed'));
      }
      this.pendingRequests.clear();
    };

    // Initialize the LSP session
    await this.initialize(workspaceRoot);

    // Register all Monaco providers
    this.registerProviders(monacoInstance);
  }

  // ── LSP Lifecycle ────────────────────────────────────────────────────────

  private async initialize(workspaceRoot: string): Promise<void> {
    const workspaceUri = `file://${workspaceRoot}`;

    await this.sendRequest('initialize', {
      processId: null,
      clientInfo: { name: 'PDV', version: '1.0' },
      rootUri: workspaceUri,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            didSave: false,
            willSaveWaitUntil: false,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: false,
              commitCharactersSupport: false,
              documentationFormat: ['plaintext'],
              deprecatedSupport: true,
              preselectSupport: false,
            },
            completionItemKind: { valueSet: Object.keys(LSP_KIND_TO_MONACO).map(Number) },
            contextSupport: true,
          },
          hover: {
            dynamicRegistration: false,
            contentFormat: ['plaintext', 'markdown'],
          },
          signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: {
              documentationFormat: ['plaintext'],
              parameterInformation: { labelOffsetSupport: false },
            },
            contextSupport: false,
          },
          definition: { dynamicRegistration: false, linkSupport: false },
          publishDiagnostics: {
            relatedInformation: false,
            tagSupport: { valueSet: [1, 2] },
          },
        },
        workspace: {
          applyEdit: false,
          workspaceEdit: { documentChanges: false },
          didChangeConfiguration: { dynamicRegistration: false },
          symbol: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [{ uri: workspaceUri, name: 'workspace' }],
    });

    this.sendNotification('initialized', {});
  }

  // ── Document sync ────────────────────────────────────────────────────────

  openDocument(uri: string, languageId: string, text: string): void {
    if (this.openDocuments.has(uri)) {
      this.changeDocument(uri, text);
      return;
    }
    this.openDocuments.add(uri);
    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  changeDocument(uri: string, text: string): void {
    if (!this.openDocuments.has(uri)) return;
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri: string): void {
    if (!this.openDocuments.has(uri)) return;
    this.openDocuments.delete(uri);
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
    // Clear diagnostics for this document
    if (this.monacoRef) {
      const model = this.monacoRef.editor
        .getModels()
        .find((m) => m.uri.toString() === uri);
      if (model) {
        this.monacoRef.editor.setModelMarkers(model, this.diagnosticsOwner, []);
      }
    }
  }

  // ── Monaco provider registration ─────────────────────────────────────────

  private registerProviders(monacoInstance: typeof monaco): void {
    // Map our languageId to the Monaco language identifier
    const monacoLanguage = this.languageId;

    // Completions
    this.disposables.push(
      monacoInstance.languages.registerCompletionItemProvider(monacoLanguage, {
        triggerCharacters: ['.', '(', ',', ' '],
        provideCompletionItems: async (model, position) => {
          const uri = model.uri.toString();
          const result = await this.sendRequest('textDocument/completion', {
            textDocument: { uri },
            position: monacoToLspPosition(position),
            context: { triggerKind: 1 },
          }).catch(() => null);

          if (!result) return { suggestions: [] };

          const items: monaco.languages.CompletionItem[] = [];
          const rawItems: unknown[] = Array.isArray(result)
            ? result
            : (result as { items?: unknown[] }).items ?? [];

          for (const item of rawItems) {
            const i = item as {
              label: string | { label: string; detail?: string };
              kind?: number;
              detail?: string;
              documentation?: string | { value: string };
              insertText?: string;
              textEdit?: { range: unknown; newText: string };
              sortText?: string;
              deprecated?: boolean;
            };

            const label = typeof i.label === 'string' ? i.label : i.label.label;
            const kindNum = i.kind ?? 1;
            const monacoKind = LSP_KIND_TO_MONACO[kindNum] ?? (monacoInstance.languages.CompletionItemKind.Text);

            const docText =
              typeof i.documentation === 'string'
                ? i.documentation
                : (i.documentation as { value: string } | undefined)?.value ?? '';

            let range: monaco.IRange;
            if (i.textEdit && typeof (i.textEdit as { range?: unknown }).range === 'object') {
              range = lspToMonacoRange((i.textEdit as { range: Parameters<typeof lspToMonacoRange>[0] }).range);
            } else {
              const word = model.getWordUntilPosition(position);
              range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              };
            }

            items.push({
              label,
              kind: monacoKind,
              detail: i.detail,
              documentation: docText,
              insertText: i.textEdit?.newText ?? i.insertText ?? label,
              sortText: i.sortText,
              range,
              tags: i.deprecated ? [1] : undefined,
            });
          }

          return { suggestions: items };
        },
      }),
    );

    // Hover
    this.disposables.push(
      monacoInstance.languages.registerHoverProvider(monacoLanguage, {
        provideHover: async (model, position) => {
          const uri = model.uri.toString();
          const result = await this.sendRequest('textDocument/hover', {
            textDocument: { uri },
            position: monacoToLspPosition(position),
          }).catch(() => null);

          if (!result) return null;

          const hover = result as {
            contents?: unknown;
            range?: Parameters<typeof lspToMonacoRange>[0];
          };

          const contents: monaco.IMarkdownString[] = [];
          if (Array.isArray(hover.contents)) {
            for (const c of hover.contents) {
              const text = typeof c === 'string' ? c : (c as { value: string }).value ?? '';
              if (text) contents.push({ value: text });
            }
          } else if (typeof hover.contents === 'string') {
            contents.push({ value: hover.contents });
          } else if (hover.contents && typeof (hover.contents as { value: string }).value === 'string') {
            contents.push({ value: (hover.contents as { value: string }).value });
          }

          if (contents.length === 0) return null;

          return {
            contents,
            range: hover.range ? lspToMonacoRange(hover.range) : undefined,
          };
        },
      }),
    );

    // Signature Help
    this.disposables.push(
      monacoInstance.languages.registerSignatureHelpProvider(monacoLanguage, {
        signatureHelpTriggerCharacters: ['(', ','],
        provideSignatureHelp: async (model, position) => {
          const uri = model.uri.toString();
          const result = await this.sendRequest('textDocument/signatureHelp', {
            textDocument: { uri },
            position: monacoToLspPosition(position),
          }).catch(() => null);

          if (!result) return null;

          const sh = result as {
            signatures: Array<{
              label: string;
              documentation?: string | { value: string };
              parameters?: Array<{ label: string | [number, number]; documentation?: string | { value: string } }>;
            }>;
            activeSignature?: number;
            activeParameter?: number;
          };

          return {
            value: {
              signatures: sh.signatures.map((sig) => ({
                label: sig.label,
                documentation: { value: typeof sig.documentation === 'string' ? sig.documentation : sig.documentation?.value ?? '' },
                parameters: (sig.parameters ?? []).map((p) => ({
                  label: p.label,
                  documentation: { value: typeof p.documentation === 'string' ? p.documentation : p.documentation?.value ?? '' },
                })),
              })),
              activeSignature: sh.activeSignature ?? 0,
              activeParameter: sh.activeParameter ?? 0,
            },
            dispose: () => { /* no-op */ },
          };
        },
      }),
    );

    // Go to Definition
    this.disposables.push(
      monacoInstance.languages.registerDefinitionProvider(monacoLanguage, {
        provideDefinition: async (model, position) => {
          const uri = model.uri.toString();
          const result = await this.sendRequest('textDocument/definition', {
            textDocument: { uri },
            position: monacoToLspPosition(position),
          }).catch(() => null);

          if (!result) return null;

          const locations: monaco.languages.Location[] = [];
          const rawLocs = Array.isArray(result) ? result : [result];

          for (const loc of rawLocs) {
            const l = loc as { uri: string; range: Parameters<typeof lspToMonacoRange>[0] };
            if (!l?.uri || !l?.range) continue;
            try {
              locations.push({
                uri: monacoInstance.Uri.parse(l.uri),
                range: lspToMonacoRange(l.range),
              });
            } catch {
              // skip malformed location
            }
          }

          return locations;
        },
      }),
    );

    // Subscribe to diagnostics notifications
    this.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as {
        uri: string;
        diagnostics: Array<{
          range: Parameters<typeof lspToMonacoRange>[0];
          message: string;
          severity?: number;
          source?: string;
          code?: string | number;
        }>;
      };

      const model = monacoInstance.editor
        .getModels()
        .find((m) => m.uri.toString() === p.uri);

      if (!model) return;

      const markers: monaco.editor.IMarkerData[] = p.diagnostics.map((d) => ({
        ...lspToMonacoRange(d.range),
        message: d.message,
        // LSP severity: 1=Error, 2=Warning, 3=Information, 4=Hint
        severity:
          d.severity === 1
            ? monacoInstance.MarkerSeverity.Error
            : d.severity === 2
            ? monacoInstance.MarkerSeverity.Warning
            : d.severity === 3
            ? monacoInstance.MarkerSeverity.Info
            : monacoInstance.MarkerSeverity.Hint,
        source: d.source,
        code: String(d.code ?? ''),
      }));

      monacoInstance.editor.setModelMarkers(model, this.diagnosticsOwner, markers);
    });
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────────

  sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) {
        reject(new Error('LSP WebSocket not connected'));
        return;
      }
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(msg));

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
        }
      }, 5000);
    });
  }

  sendNotification(method: string, params: unknown): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.ws.send(JSON.stringify(msg));
  }

  private onNotification(method: string, handler: (params: unknown) => void): void {
    const existing = this.notificationHandlers.get(method) ?? [];
    existing.push(handler);
    this.notificationHandlers.set(method, existing);
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if ('id' in msg && 'result' in msg) {
      // Response
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(resp.error.message));
        } else {
          pending.resolve(resp.result);
        }
      }
    } else if ('id' in msg && 'error' in msg) {
      // Error response
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        pending.reject(new Error(resp.error?.message ?? 'Unknown LSP error'));
      }
    } else if (!('id' in msg)) {
      // Notification
      const notif = msg as JsonRpcNotification;
      const handlers = this.notificationHandlers.get(notif.method) ?? [];
      for (const handler of handlers) {
        try {
          handler(notif.params);
        } catch (e) {
          console.error(`[lsp-client] Notification handler error for ${notif.method}:`, e);
        }
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.pendingRequests.clear();
    this.openDocuments.clear();
  }

  get isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN;
  }
}
