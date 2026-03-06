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

let completionProviderRegistered = false;
let hoverProviderRegistered = false;
let activeKernelIdRef: React.MutableRefObject<string | null> | null = null;
let allTabsRef: React.MutableRefObject<{ id: number; code: string; active: boolean }[]> | null = null;

/** Returns a newline-terminated string of all non-active tabs' code to give jedi cross-cell import context. */
function buildContextPrefix(): string {
  const tabs = allTabsRef?.current ?? [];
  const otherCode = tabs
    .filter((t) => !t.active)
    .map((t) => t.code.trim())
    .filter(Boolean)
    .join('\n');
  return otherCode ? otherCode + '\n' : '';
}

interface TreePathCompletionContext {
  ancestorSegments: string[];
  typedSegment: string;
  segmentStartOffset: number;
}

function extractTreePathCompletionContext(
  code: string,
  offset: number
): TreePathCompletionContext | null {
  const textBeforeCursor = code.slice(0, offset);
  const match = /pdv_tree((?:\[\s*['"][^'"\\]*['"]\s*\])*)\[\s*['"]([^'"\\]*)$/.exec(
    textBeforeCursor
  );
  if (!match) return null;
  const completedSegments = match[1];
  const typedSegment = match[2];
  const ancestorSegments: string[] = [];
  const segmentRegex = /\[\s*['"]([^'"\\]*)['"]\s*\]/g;
  let segmentMatch: RegExpExecArray | null;
  while ((segmentMatch = segmentRegex.exec(completedSegments)) !== null) {
    ancestorSegments.push(segmentMatch[1]);
  }
  return {
    ancestorSegments,
    typedSegment,
    segmentStartOffset: offset - typedSegment.length,
  };
}

interface TreePathSuggestion {
  label: string;
  insertText: string;
}

async function getTreePathSuggestions(
  kernelId: string,
  context: TreePathCompletionContext
): Promise<TreePathSuggestion[]> {
  const typedParts = context.typedSegment.split('.');
  const extraParentSegments =
    typedParts.length > 1 ? typedParts.slice(0, -1).filter(Boolean) : [];
  const keyPrefix = typedParts[typedParts.length - 1] ?? '';
  const parentSegments = [...context.ancestorSegments, ...extraParentSegments];
  const parentPath = parentSegments.join('.');
  const nodes = await window.pdv.tree.list(kernelId, parentPath);
  return nodes
    .filter((node) => node.key.startsWith(keyPrefix))
    .map((node) => ({
      label: node.path,
      insertText: [...extraParentSegments, node.key].join('.'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function mapCompletionKind(
  monacoInstance: typeof monaco,
  rawType: string | undefined
): monaco.languages.CompletionItemKind {
  switch (rawType) {
    case 'function':
    case 'builtin_function_or_method':
      return monacoInstance.languages.CompletionItemKind.Function;
    case 'module':
      return monacoInstance.languages.CompletionItemKind.Module;
    case 'class':
      return monacoInstance.languages.CompletionItemKind.Class;
    case 'keyword':
      return monacoInstance.languages.CompletionItemKind.Keyword;
    case 'property':
      return monacoInstance.languages.CompletionItemKind.Property;
    case 'statement':
      return monacoInstance.languages.CompletionItemKind.Snippet;
    case 'instance':
      return monacoInstance.languages.CompletionItemKind.Variable;
    default:
      return monacoInstance.languages.CompletionItemKind.Variable;
  }
}

function registerKernelCompletionProvider(monacoInstance: typeof monaco): void {
  if (completionProviderRegistered) return;
  completionProviderRegistered = true;

  monacoInstance.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '[', "'", '"'],
    async provideCompletionItems(model, position, context) {
      const kernelId = activeKernelIdRef?.current ?? null;
      if (!kernelId) return { suggestions: [] };

      const code = model.getValue();
      const offset = model.getOffsetAt(position);
      const treePathContext = extractTreePathCompletionContext(code, offset);
      if (treePathContext) {
        try {
          const matches = await getTreePathSuggestions(
            kernelId,
            treePathContext
          );
          const startPosition = model.getPositionAt(treePathContext.segmentStartOffset);
          const endPosition = model.getPositionAt(offset);
          const range = new monacoInstance.Range(
            startPosition.lineNumber,
            startPosition.column,
            endPosition.lineNumber,
            endPosition.column
          );
          return {
            suggestions: matches.map((match, index) => ({
              label: match.label,
              kind: monacoInstance.languages.CompletionItemKind.Variable,
              insertText: match.insertText,
              range,
              sortText: String(index).padStart(5, '0'),
            })),
          };
        } catch (error) {
          console.warn('[CodeCell] Tree path completion request failed', error);
          return { suggestions: [] };
        }
      }

      if (
        context?.triggerCharacter === "'" ||
        context?.triggerCharacter === '"'
      ) {
        return { suggestions: [] };
      }

      try {
        const prefix = buildContextPrefix();
        const prefixedCode = prefix + code;
        const prefixedOffset = prefix.length + offset;
        const result = await window.pdv.kernels.complete(kernelId, prefixedCode, prefixedOffset);
        const textBeforeCursor = code.slice(0, offset);
        const namePrefix = textBeforeCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '';
        let mergedMatches = [...result.matches];
        // ipykernel completion can omit protected PDV locals from top-level name
        // completion; ensure the two built-ins are always discoverable.
        if (namePrefix) {
          for (const builtin of ['pdv_tree', 'pdv']) {
            if (builtin.startsWith(namePrefix) && !mergedMatches.includes(builtin)) {
              mergedMatches.push(builtin);
            }
          }
        }
        const adjustedStart = Math.max(0, result.cursor_start - prefix.length);
        const adjustedEnd = Math.max(0, result.cursor_end - prefix.length);
        const startPosition = model.getPositionAt(adjustedStart);
        const endPosition = model.getPositionAt(adjustedEnd);
        const range = new monacoInstance.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column
        );

        const kindByMatch = new Map<string, monaco.languages.CompletionItemKind>();
        const experimental = result.metadata?._jupyter_types_experimental;
        if (Array.isArray(experimental)) {
          for (const item of experimental) {
            if (
              item &&
              typeof item === 'object' &&
              'text' in item &&
              'type' in item &&
              typeof item.text === 'string' &&
              typeof item.type === 'string'
            ) {
              kindByMatch.set(item.text, mapCompletionKind(monacoInstance, item.type));
            }
          }
        }

        return {
          suggestions: mergedMatches.map((match, index) => ({
            label: match,
            kind: kindByMatch.get(match) ?? monacoInstance.languages.CompletionItemKind.Variable,
            insertText: match,
            range,
            sortText: String(index).padStart(5, '0'),
          })),
        };
      } catch (error) {
        console.warn('[CodeCell] Completion request failed', error);
        return { suggestions: [] };
      }
    },
  });
}

function registerKernelHoverProvider(monacoInstance: typeof monaco): void {
  if (hoverProviderRegistered) return;
  hoverProviderRegistered = true;

  monacoInstance.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      const kernelId = activeKernelIdRef?.current ?? null;
      if (!kernelId) return null;

      try {
        const code = model.getValue();
        const prefix = buildContextPrefix();
        const offset = prefix.length + model.getOffsetAt(position);
        const result = await window.pdv.kernels.inspect(kernelId, prefix + code, offset);
        const rawDoc = result.data?.['text/plain'];
        if (!result.found || typeof rawDoc !== 'string' || !rawDoc.trim()) {
          return null;
        }
        // Strip ANSI escape sequences (color/bold codes) that ipykernel injects for terminal display.
        const doc = rawDoc.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        const word = model.getWordAtPosition(position);
        return {
          contents: [{ value: `\`\`\`text\n${doc}\n\`\`\`` }],
          range: word
            ? new monacoInstance.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn
            )
            : undefined,
        };
      } catch (error) {
        console.warn('[CodeCell] Inspect request failed', error);
        return null;
      }
    },
  });
}

/** Props for the tabbed code-cell editor pane. */
export interface CodeCellProps {
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
  activeKernelIdRef = kernelIdRef;
  const allTabsDataRef = useRef(tabs.map((t) => ({ id: t.id, code: t.code, active: t.id === activeTabId })));
  allTabsRef = allTabsDataRef;

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

  if (!activeTab) {
    return null;
  }

  const handleBeforeMount: BeforeMount = (monaco) => {
    defineMonacoThemes(monaco);
    registerKernelCompletionProvider(monaco);
    registerKernelHoverProvider(monaco);
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
