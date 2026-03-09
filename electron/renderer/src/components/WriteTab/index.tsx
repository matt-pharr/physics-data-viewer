/**
 * WriteTab — tabbed markdown note editor pane.
 *
 * Renders tab chrome for open markdown notes with a Monaco editor in markdown
 * mode. Mirrors the CodeCell pane structure but configured for prose writing
 * rather than code execution. Supports auto-save with dirty detection.
 *
 * Does NOT handle note creation or tree interactions — those are delegated
 * to callbacks owned by `App`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { NoteTab } from '../../types';
import { defineMonacoThemes } from '../../themes';
import { attachMathPreview } from './math-preview';
import { ReadView } from './ReadView';
import 'katex/dist/katex.min.css';

/** Props for the tabbed markdown note editor pane. */
interface WriteTabProps {
  tabs: NoteTab[];
  activeTabId: string | null;
  disabled?: boolean;
  onTabChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  onContentChange: (id: string, content: string) => void;
  onSave: (id: string) => void;
  monacoTheme?: string;
  editorFontFamily?: string;
  editorFontSize?: number;
  editorWordWrap?: boolean;
}

/** Tabbed markdown note editor component used by the main workspace. */
export const WriteTab: React.FC<WriteTabProps> = ({
  tabs,
  activeTabId,
  disabled = false,
  onTabChange,
  onCloseTab,
  onContentChange,
  onSave,
  monacoTheme = 'vs-dark',
  editorFontFamily,
  editorFontSize,
  editorWordWrap,
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mathPreviewDisposeRef = useRef<(() => void) | null>(null);
  const [readMode, setReadMode] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const handleBeforeMount: BeforeMount = (monacoInstance) => {
    defineMonacoThemes(monacoInstance);
  };

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;

    // Attach KaTeX math previews
    if (mathPreviewDisposeRef.current) mathPreviewDisposeRef.current();
    mathPreviewDisposeRef.current = attachMathPreview(editor, monacoInstance);
  };

  // Debounced auto-save: 5 seconds after last change
  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activeTabId) return;
      const content = value ?? '';
      onContentChange(activeTabId, content);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        onSave(activeTabId);
      }, 5000);
    },
    [activeTabId, onContentChange, onSave],
  );

  // Cleanup debounce timer and math preview on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (mathPreviewDisposeRef.current) mathPreviewDisposeRef.current();
    };
  }, []);

  if (tabs.length === 0) {
    return (
      <section className="write-tab-pane">
        <header className="pane-header">
          <h2>Notes</h2>
        </header>
        <div className="write-tab-empty">
          <p>No notes open</p>
          <p className="write-tab-hint">
            Right-click a folder in the Tree and select &ldquo;Create new note&rdquo;,
            or click &ldquo;Open&rdquo; on an existing markdown node.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="write-tab-pane">
      <header className="pane-header">
        <h2>Notes</h2>

        <div className="write-mode-toggle">
          <button
            className={`btn btn-sm ${!readMode ? 'btn-active' : 'btn-secondary'}`}
            onClick={() => setReadMode(false)}
          >
            Edit
          </button>
          <button
            className={`btn btn-sm ${readMode ? 'btn-active' : 'btn-secondary'}`}
            onClick={() => setReadMode(true)}
          >
            Read
          </button>
        </div>

        <div className="code-cell-tabs">
          {tabs.map((tab) => {
            return (
              <button
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={() => onTabChange(tab.id)}
                title={tab.id}
              >
                {tab.name}
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close ${tab.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="code-cell-content">
        {activeTab && readMode ? (
          <ReadView content={activeTab.content} />
        ) : activeTab ? (
          <Editor
            key={activeTab.id}
            height="100%"
            theme={monacoTheme}
            language="markdown"
            value={activeTab.content}
            onChange={handleChange}
            beforeMount={handleBeforeMount}
            onMount={handleEditorMount}
            options={{
              readOnly: disabled,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              overviewRulerLanes: 0,

              fontSize: editorFontSize ?? 14,
              fontFamily: editorFontFamily || undefined,
              wordWrap: editorWordWrap === false ? 'off' : 'on',

              lineNumbers: 'off',
              folding: false,
              glyphMargin: false,
              renderLineHighlight: 'none',

              // Disable code-oriented features for prose writing
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              wordBasedSuggestions: 'off',
              parameterHints: { enabled: false },
              acceptSuggestionOnEnter: 'off',

              formatOnPaste: false,
              formatOnType: false,

              smoothScrolling: true,
              cursorSurroundingLines: 3,
              padding: { top: 12, bottom: 12 },
            }}
          />
        ) : null}
      </div>
    </section>
  );
};
