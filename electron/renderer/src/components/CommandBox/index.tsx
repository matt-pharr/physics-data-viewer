import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { CommandTab } from '../../types';
import { LspClient } from '../../services/lsp-client';
import type { LspConnectionState } from '../../../../main/ipc';

export interface CommandBoxProps {
  tabs: (CommandTab & { onChange: (code: string) => void })[];
  activeTabId: number;
  onTabChange: (id: number) => void;
  onAddTab: () => void;
  onRemoveTab?: (id: number) => void;
  onExecute: (code: string) => void;
  onClear: () => void;
  isExecuting: boolean;
  lastError?: string;
  /** When provided, connect this LSP proxy port for Python intelligence */
  lspProxyPort?: number;
  /** Current LSP connection state for status indicator */
  lspState?: LspConnectionState;
  /** Called when the user clicks the LSP status indicator */
  onLspStatusClick?: () => void;
  /** Workspace root passed to the LSP server (defaults to '/') */
  workspaceRoot?: string;
}

function lspStatusLabel(state: LspConnectionState | undefined): { dot: string; title: string } {
  switch (state) {
    case 'connected':
      return { dot: '🟢', title: 'Language server connected' };
    case 'starting':
      return { dot: '🟡', title: 'Language server starting…' };
    case 'detecting':
      return { dot: '🟡', title: 'Detecting language server…' };
    case 'launchable':
      return { dot: '🟠', title: 'Language server available but not started — click to configure' };
    case 'external_running':
      return { dot: '🟠', title: 'External language server found — click to connect' };
    case 'not_found':
      return { dot: '⚫', title: 'No language server found — click to configure' };
    case 'error':
      return { dot: '🔴', title: 'Language server error — click to configure' };
    case 'disabled':
      return { dot: '⚫', title: 'Language server disabled' };
    default:
      return { dot: '⚫', title: 'Language server not configured — click to set up' };
  }
}

export const CommandBox: React.FC<CommandBoxProps> = ({
  tabs,
  activeTabId,
  onTabChange,
  onAddTab,
  onRemoveTab,
  onExecute,
  onClear,
  isExecuting,
  lastError,
  lspProxyPort,
  lspState,
  onLspStatusClick,
  workspaceRoot = '/',
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);
  const activeTabRef = useRef(activeTab);
  const isExecutingRef = useRef(isExecuting);
  const lspClientRef = useRef<LspClient | null>(null);
  const activeDocUriRef = useRef<string | null>(null);
  const changeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);

  // Connect / disconnect LSP client when proxyPort changes or editor becomes available
  useEffect(() => {
    if (!lspProxyPort || !monacoRef.current) return;

    const client = new LspClient('python');
    lspClientRef.current = client;

    client
      .connect(lspProxyPort, monacoRef.current, workspaceRoot)
      .then(() => {
        console.log('[CommandBox] LSP client connected');
        // Open the current active tab as a document
        if (activeTabRef.current) {
          const uri = `pdv-memory://session/tab-${activeTabRef.current.id}.py`;
          activeDocUriRef.current = uri;
          client.openDocument(uri, 'python', activeTabRef.current.code);
        }
      })
      .catch((err: unknown) => {
        console.error('[CommandBox] LSP connect error:', err);
      });

    return () => {
      client.dispose();
      lspClientRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lspProxyPort, editorMounted]);

  // When active tab changes, notify LSP of the new document
  useEffect(() => {
    const client = lspClientRef.current;
    if (!client || !client.isConnected || !activeTab) return;

    const newUri = `pdv-memory://session/tab-${activeTab.id}.py`;
    if (activeDocUriRef.current && activeDocUriRef.current !== newUri) {
      // The old URI stays open (LSP caches it), we just switch focus
    }
    activeDocUriRef.current = newUri;
    client.openDocument(newUri, 'python', activeTab.code);
  }, [activeTab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeTab) {
    return null;
  }

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;
    setEditorMounted(true);

    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter, () => {
      if (!isExecutingRef.current && activeTabRef.current) {
        onExecute(activeTabRef.current.code);
      }
    });

  };

  const handleExecute = () => {
    if (!isExecuting && activeTab.code.trim()) {
      onExecute(activeTab.code);
    }
  };

  const handleClear = () => {
    activeTab.onChange('');
    onClear();
  };

  const handleClose = () => {
    if (onRemoveTab) {
      onRemoveTab(activeTab.id);
    } else {
      handleClear();
    }
  };

  const handleCodeChange = (value: string) => {
    activeTab.onChange(value);

    // Debounce LSP didChange notifications (100ms)
    if (changeDebounceRef.current) clearTimeout(changeDebounceRef.current);
    changeDebounceRef.current = setTimeout(() => {
      const client = lspClientRef.current;
      const uri = activeDocUriRef.current;
      if (client && client.isConnected && uri) {
        client.changeDocument(uri, value);
      }
    }, 100);
  };

  const isEmpty = !activeTab.code.trim();
  const { dot, title } = lspStatusLabel(lspState);

  return (
    <section className="command-pane">
      <header className="pane-header">
        <h2>Command</h2>

        <div className="command-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.id}
              {onRemoveTab && (
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close tab ${tab.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveTab(tab.id);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button className="tab add" onClick={onAddTab}>
            +
          </button>
        </div>

        <div className="pane-actions">
          <button
            className="lsp-status-btn"
            title={title}
            onClick={onLspStatusClick}
            aria-label={title}
          >
            {dot}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleExecute}
            disabled={isExecuting || !activeTab.code.trim()}
          >
            {isExecuting ? 'Running...' : 'Execute'}
          </button>
          <button className="btn btn-secondary" onClick={isEmpty ? handleClose : handleClear} disabled={isExecuting}>
            {isEmpty ? 'Close' : 'Clear'}
          </button>
        </div>
      </header>

      <div className="command-content">
        <Editor
          height="100%"
          theme="vs-dark"
          language="python"
          path={`pdv-memory://session/tab-${activeTab.id}.py`}
          value={activeTab.code}
          onChange={(value) => handleCodeChange(value || '')}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            acceptSuggestionOnEnter: 'off',
          }}
        />
      </div>

      {lastError && (
        <div className="command-error-bar">
          <span>{lastError}</span>
        </div>
      )}
    </section>
  );
};
