import React, { useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { CommandTab } from '../../types';

// ---------------------------------------------------------------------------
// Module-level state for Monaco providers (registered once, persist for app lifetime)
// ---------------------------------------------------------------------------

/** Updated by CommandBox whenever the active kernel changes. */
const activeKernelIdRef: { current: string | null } = { current: null };

/** Guards against registering the providers more than once. */
let monacoProvidersRegistered = false;

/**
 * Register Monaco completion and hover providers for Python.
 *
 * Called once on first editor mount. Providers are global to the Monaco
 * instance — calling this more than once would register duplicate providers
 * and produce duplicate suggestions, hence the guard above.
 *
 * @param monacoInstance - The Monaco API object from `@monaco-editor/react`.
 */
function registerMonacoProviders(monacoInstance: typeof monaco): void {
  if (monacoProvidersRegistered) return;
  monacoProvidersRegistered = true;

  // Completion provider: calls the kernel's complete_request and maps results
  // to Monaco CompletionItems. Trigger characters match VSCode Jupyter.
  monacoInstance.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '[', "'", '"'],
    async provideCompletionItems(model, position, _context, token) {
      const kernelId = activeKernelIdRef.current;
      if (!kernelId || !window.pdv?.kernels?.complete) {
        return { suggestions: [] };
      }

      const code = model.getValue();
      const offset = model.getOffsetAt(position);

      if (token.isCancellationRequested) return { suggestions: [] };

      try {
        const result = await window.pdv.kernels.complete(kernelId, code, offset);

        if (token.isCancellationRequested) return { suggestions: [] };

        const startPos = model.getPositionAt(result.cursor_start);
        const endPos = model.getPositionAt(result.cursor_end);
        const range: monaco.IRange = {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        };

        const suggestions: monaco.languages.CompletionItem[] = result.matches.map((match) => ({
          label: match,
          kind: monacoInstance.languages.CompletionItemKind.Text,
          insertText: match,
          range,
        }));

        return { suggestions };
      } catch {
        return { suggestions: [] };
      }
    },
  });

  // Hover provider: calls the kernel's inspect_request and renders the
  // returned docstring in a Monaco hover popup.
  monacoInstance.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      const kernelId = activeKernelIdRef.current;
      if (!kernelId || !window.pdv?.kernels?.inspect) {
        return undefined;
      }

      const code = model.getValue();
      const offset = model.getOffsetAt(position);

      try {
        const result = await window.pdv.kernels.inspect(kernelId, code, offset);
        if (!result.found || !result.data?.['text/plain']) {
          return undefined;
        }
        return {
          contents: [{ value: '```\n' + result.data['text/plain'] + '\n```' }],
        };
      } catch {
        return undefined;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// CommandBox component
// ---------------------------------------------------------------------------

/**
 * A single diagnostic marker shown as a squiggly underline in the editor.
 * Line and column numbers are 1-based to match Monaco's coordinate system.
 */
export interface DiagnosticMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface CommandBoxProps {
  tabs: (CommandTab & { onChange: (code: string) => void })[];
  activeTabId: number;
  /** The active kernel ID, used by the Monaco completion and hover providers. */
  kernelId?: string | null;
  /**
   * Diagnostic markers to render as squiggly underlines.
   * Provided by App after debounced kernel-side syntax checking.
   */
  markers?: DiagnosticMarker[];
  disabled?: boolean;
  onTabChange: (id: number) => void;
  onAddTab: () => void;
  onRemoveTab?: (id: number) => void;
  onExecute: (code: string) => void;
  onClear: () => void;
  isExecuting: boolean;
  lastError?: string;
}

export const CommandBox: React.FC<CommandBoxProps> = ({
  tabs,
  activeTabId,
  kernelId,
  markers = [],
  disabled = false,
  onTabChange,
  onAddTab,
  onRemoveTab,
  onExecute,
  onClear,
  isExecuting,
  lastError,
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);
  const activeTabRef = useRef(activeTab);
  const isExecutingRef = useRef(isExecuting);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);

  // Keep the module-level kernel ref in sync so Monaco providers always use
  // the current kernel without needing to re-register.
  useEffect(() => {
    activeKernelIdRef.current = kernelId ?? null;
  }, [kernelId]);

  // Apply diagnostic markers to the editor model whenever the prop changes.
  // Monaco.editor.setModelMarkers replaces all markers for the given owner,
  // so passing an empty array clears them.
  useEffect(() => {
    const editor = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!editor || !monacoApi) return;
    const model = editor.getModel();
    if (!model) return;

    monacoApi.editor.setModelMarkers(
      model,
      'pdv-diagnostics',
      markers.map((m) => ({
        startLineNumber: m.startLineNumber,
        startColumn: m.startColumn,
        endLineNumber: m.endLineNumber,
        endColumn: m.endColumn,
        message: m.message,
        severity:
          m.severity === 'error'
            ? monacoApi.MarkerSeverity.Error
            : monacoApi.MarkerSeverity.Warning,
      }))
    );
  }, [markers]);

  if (!activeTab) {
    return null;
  }

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;

    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter, () => {
      if (!disabled && !isExecutingRef.current && activeTabRef.current) {
        onExecute(activeTabRef.current.code);
      }
    });

    // Register the kernel-backed completion and hover providers once globally.
    registerMonacoProviders(monacoInstance);
  };

  const handleExecute = () => {
    if (!disabled && !isExecuting && activeTab.code.trim()) {
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

  const isEmpty = !activeTab.code.trim();

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
              disabled={disabled}
            >
              {tab.id}
              {onRemoveTab && (
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close tab ${tab.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!disabled) onRemoveTab(tab.id);
                    }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button className="tab add" onClick={onAddTab} disabled={disabled}>
            +
          </button>
        </div>

        <div className="pane-actions">
            <button
              className="btn btn-primary"
              onClick={handleExecute}
              disabled={disabled || isExecuting || !activeTab.code.trim()}
            >
              {isExecuting ? 'Running...' : 'Execute'}
            </button>
          <button className="btn btn-secondary" onClick={isEmpty ? handleClose : handleClear} disabled={disabled || isExecuting}>
            {isEmpty ? 'Close' : 'Clear'}
          </button>
        </div>
      </header>

      <div className="command-content">
        <Editor
          height="100%"
          theme="vs-dark"
          language="python"
          value={activeTab.code}
          onChange={(value) => activeTab.onChange(value || '')}
          onMount={handleEditorMount}
          options={{
            readOnly: disabled,
            // Layout
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            overviewRulerLanes: 0,

            // Typography
            fontSize: 13,
            wordWrap: 'on',

            // Gutter
            lineNumbers: 'on',
            folding: false,
            glyphMargin: true,

            // Indentation — enforce Python conventions, never infer from content
            tabSize: 4,
            insertSpaces: true,
            detectIndentation: false,

            // Suggestions — kernel-backed completions via complete_request/inspect_request
            quickSuggestions: { other: true, comments: false, strings: true },
            suggestOnTriggerCharacters: true,
            wordBasedSuggestions: 'off',
            parameterHints: { enabled: false },

            // Formatting — preserve user intent when pasting code
            formatOnPaste: false,
            formatOnType: false,

            // Scroll / cursor
            smoothScrolling: true,
            cursorSurroundingLines: 3,
          }}
        />
      </div>

      {lastError && (
        <div className="command-error-bar">
          <span>{lastError}</span>
        </div>
      )}
      {disabled && (
        <div className="command-error-bar">
          <span>Starting kernel...</span>
        </div>
      )}
    </section>
  );
};
