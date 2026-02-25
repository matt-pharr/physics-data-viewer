import React, { useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { CommandTab } from '../../types';
import type { Shortcuts } from '../../shortcuts';
import { matchesShortcut } from '../../shortcuts';

export interface CommandBoxProps {
  tabs: (CommandTab & { onChange: (code: string) => void })[];
  activeTabId: number;
  disabled?: boolean;
  onTabChange: (id: number) => void;
  onAddTab: () => void;
  onRemoveTab?: (id: number) => void;
  onExecute: (code: string) => void;
  onClear: () => void;
  isExecuting: boolean;
  lastError?: string;
  shortcuts: Shortcuts;
}

export const CommandBox: React.FC<CommandBoxProps> = ({
  tabs,
  activeTabId,
  disabled = false,
  onTabChange,
  onAddTab,
  onRemoveTab,
  onExecute,
  onClear,
  isExecuting,
  lastError,
  shortcuts,
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);
  const activeTabRef = useRef(activeTab);
  const isExecutingRef = useRef(isExecuting);
  const disabledRef = useRef(disabled);
  const shortcutsRef = useRef(shortcuts);
  const onAddTabRef = useRef(onAddTab);
  const onRemoveTabRef = useRef(onRemoveTab);

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

  if (!activeTab) {
    return null;
  }

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
            glyphMargin: false,

            // Indentation — enforce Python conventions, never infer from content
            tabSize: 4,
            insertSpaces: true,
            detectIndentation: false,

            // Suggestions — disabled in favour of future kernel-backed completions (see UPCOMING_FEATURES §13)
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
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
