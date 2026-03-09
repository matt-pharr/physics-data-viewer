/**
 * CodeCell editor pane with tabbed Monaco instances.
 *
 * Renders tab chrome, Execute/Clear actions, and keyboard shortcut bindings
 * for cell-level operations (execute/new/close). Execution itself is delegated
 * to callbacks owned by `App`.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { CellTab } from '../../types';
import type { Shortcuts } from '../../shortcuts';
import { matchesShortcut } from '../../shortcuts';
import { defineMonacoThemes } from '../../themes';
import { registerKernelCompletionProvider, registerKernelHoverProvider } from './monaco-providers';

/** Props for the tabbed code-cell editor pane. */
interface CodeCellProps {
  executionError?: {
    tabId: number;
    message: string;
    location?: { line?: number; column?: number };
  };
  tabs: (CellTab & { onChange: (code: string) => void })[];
  activeTabId: number;
  kernelId?: string | null;
  disabled?: boolean;
  onTabChange: (id: number) => void;
  onAddTab: () => void;
  onRemoveTab?: (id: number) => void;
  onExecute: (code: string) => void;
  onInterrupt?: () => void;
  onClear: () => void;
  isExecuting: boolean;
  lastError?: string;
  shortcuts: Shortcuts;
  monacoTheme?: string;
  editorFontFamily?: string;
  editorFontSize?: number;
  editorTabSize?: number;
  editorWordWrap?: boolean;
}

/** Tabbed code-cell editor component used by the main workspace. */
export const CodeCell: React.FC<CodeCellProps> = ({
  executionError,
  tabs,
  activeTabId,
  kernelId = null,
  disabled = false,
  onTabChange,
  onAddTab,
  onRemoveTab,
  onExecute,
  onInterrupt,
  onClear,
  isExecuting,
  lastError,
  shortcuts,
  monacoTheme = 'vs-dark',
  editorFontFamily,
  editorFontSize,
  editorTabSize,
  editorWordWrap,
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);
  const activeTabRef = useRef(activeTab);
  const isExecutingRef = useRef(isExecuting);
  const disabledRef = useRef(disabled);
  const shortcutsRef = useRef(shortcuts);
  const onAddTabRef = useRef(onAddTab);
  const onRemoveTabRef = useRef(onRemoveTab);
  const tabsRef = useRef(tabs);
  const onTabChangeRef = useRef(onTabChange);
  const kernelIdRef = useRef<string | null>(kernelId);
  const allTabsDataRef = useRef(tabs.map((t) => ({ id: t.id, code: t.code, active: t.id === activeTabId })));

  /**
   * Ref-sync block: Monaco callbacks (onKeyDown, completions, etc.) capture
   * closure state at mount time. We sync prop/state values into refs so those
   * callbacks always see current values without requiring Monaco to be
   * re-mounted on every state change.
   */
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    onAddTabRef.current = onAddTab;
  }, [onAddTab]);

  useEffect(() => {
    onRemoveTabRef.current = onRemoveTab;
  }, [onRemoveTab]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    onTabChangeRef.current = onTabChange;
  }, [onTabChange]);

  useEffect(() => {
    kernelIdRef.current = kernelId;
  }, [kernelId]);

  useEffect(() => {
    allTabsDataRef.current = tabs.map((t) => ({ id: t.id, code: t.code, active: t.id === activeTabId }));
  }, [tabs, activeTabId]);

  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!editor || !monacoInstance) return;
    const model = editor.getModel();
    if (!model) return;

    const markerOwner = 'pdv-execution';
    if (!executionError || executionError.tabId !== activeTabId) {
      monacoInstance.editor.setModelMarkers(model, markerOwner, []);
      return;
    }

    const lineCount = model.getLineCount();
    const requestedLine = executionError.location?.line;
    const lineNumber =
      typeof requestedLine === 'number' && Number.isFinite(requestedLine)
        ? Math.min(Math.max(Math.trunc(requestedLine), 1), lineCount)
        : 1;
    const lineContent = model.getLineContent(lineNumber);

    let startColumn = 1;
    let endColumn = Math.max(2, lineContent.length + 1);
    const requestedColumn = executionError.location?.column;
    if (typeof requestedColumn === 'number' && Number.isFinite(requestedColumn)) {
      const clampedColumn = Math.min(
        Math.max(Math.trunc(requestedColumn), 1),
        Math.max(1, lineContent.length + 1),
      );
      const word = model.getWordAtPosition({ lineNumber, column: clampedColumn });
      if (word) {
        startColumn = word.startColumn;
        endColumn = Math.max(word.endColumn, word.startColumn + 1);
      } else {
        startColumn = clampedColumn;
        endColumn = Math.min(clampedColumn + 1, Math.max(2, lineContent.length + 1));
      }
    } else {
      const firstVisible = lineContent.search(/\S/);
      if (firstVisible >= 0) {
        startColumn = firstVisible + 1;
        endColumn = Math.max(startColumn + 1, lineContent.length + 1);
      }
    }

    monacoInstance.editor.setModelMarkers(model, markerOwner, [
      {
        severity: monacoInstance.MarkerSeverity.Error,
        message: executionError.message || 'Execution error',
        startLineNumber: lineNumber,
        startColumn,
        endLineNumber: lineNumber,
        endColumn,
      },
    ]);
  }, [executionError, activeTabId, activeTab?.code]);

  if (!activeTab) {
    return null;
  }

  const handleBeforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;
    defineMonacoThemes(monaco);
    registerKernelCompletionProvider(monaco, kernelIdRef, allTabsDataRef);
    registerKernelHoverProvider(monaco, kernelIdRef, allTabsDataRef);
  };

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;

    editor.onKeyDown((e) => {
      // Cast to the native KeyboardEvent shape that matchesShortcut expects
      const nativeEvent = e.browserEvent;
      if (matchesShortcut(nativeEvent, shortcutsRef.current.execute)) {
        e.preventDefault();
        e.stopPropagation();
        if (!disabledRef.current && !isExecutingRef.current && activeTabRef.current) {
          onExecute(activeTabRef.current.code);
        }
      }
      if (matchesShortcut(nativeEvent, shortcutsRef.current.newTab)) {
        e.preventDefault();
        e.stopPropagation();
        onAddTabRef.current();
      }
      if (matchesShortcut(nativeEvent, shortcutsRef.current.closeTab)) {
        e.preventDefault();
        e.stopPropagation();
        const tab = activeTabRef.current;
        if (tab) onRemoveTabRef.current?.(tab.id);
      }
      if (matchesShortcut(nativeEvent, shortcutsRef.current.closeWindow)) {
        e.preventDefault();
        e.stopPropagation();
        window.close();
      }
      // Cmd+1–9 → go to nth tab; Cmd+0 → go to last tab
      if ((nativeEvent.metaKey || nativeEvent.ctrlKey) && !nativeEvent.shiftKey && !nativeEvent.altKey) {
        const digit = nativeEvent.key;
        if (digit >= '1' && digit <= '9') {
          e.preventDefault();
          e.stopPropagation();
          const t = tabsRef.current;
          const target = t[Math.min(Number(digit) - 1, t.length - 1)];
          if (target) onTabChangeRef.current(target.id);
        } else if (digit === '0') {
          e.preventDefault();
          e.stopPropagation();
          const t = tabsRef.current;
          if (t.length) onTabChangeRef.current(t[t.length - 1].id);
        }
      }
    });
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
    <section className="code-cell-pane">
      <header className="pane-header">
        <h2>Code Cells</h2>

        <div className="code-cell-tabs">
          {tabs.map((tab, i) => {
            const label = tab.name ?? String(i + 1);
            return (
              <button
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={() => onTabChange(tab.id)}
                disabled={disabled}
                title={tab.name ? `Cell ${i + 1}: ${tab.name}` : `Cell ${i + 1}`}
              >
                {label}
                {onRemoveTab && (
                  <span
                    className="tab-close"
                    role="button"
                    aria-label={`Close cell ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!disabled) onRemoveTab(tab.id);
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            );
          })}
          <button className="tab add" onClick={onAddTab} disabled={disabled}>
            +
          </button>
        </div>

        <div className="pane-actions">
          {isExecuting ? (
            <button
              className="btn btn-warning"
              onClick={onInterrupt}
              disabled={disabled || !onInterrupt}
            >
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleExecute}
              disabled={disabled || !activeTab.code.trim()}
            >
              Execute
            </button>
          )}
          <button className="btn btn-secondary" onClick={isEmpty ? handleClose : handleClear} disabled={disabled || isExecuting}>
            {isEmpty ? 'Close' : 'Clear'}
          </button>
        </div>
      </header>

      <div className="code-cell-content">
        <Editor
          height="100%"
          theme={monacoTheme}
          language="python"
          value={activeTab.code}
          onChange={(value) => activeTab.onChange(value || '')}
          beforeMount={handleBeforeMount}
          onMount={handleEditorMount}
          options={{
            readOnly: disabled,
            // Layout
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            overviewRulerLanes: 0,

            // Typography
            fontSize: editorFontSize ?? 13,
            fontFamily: editorFontFamily || undefined,
            wordWrap: editorWordWrap === false ? 'off' : 'on',

            // Gutter
            lineNumbers: 'on',
            folding: false,
            glyphMargin: false,

            // Indentation — enforce Python conventions, never infer from content
            tabSize: editorTabSize ?? 4,
            insertSpaces: true,
            detectIndentation: false,

            // Hover — prefer showing below cursor so it's not clipped at the top of the editor
            hover: { above: false },

            // Suggestions — kernel-backed completions (PLANNED_FEATURES §5)
            quickSuggestions: { other: true, comments: false, strings: false },
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
        <div className="code-cell-error-bar">
          <span>{lastError}</span>
        </div>
      )}
      {disabled && (
        <div className="code-cell-status-bar">
          <span>Starting kernel...</span>
        </div>
      )}
    </section>
  );
};
