import React, { useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import type { CommandTab } from '../../types';

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
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId]);
  const activeTabRef = useRef(activeTab);
  const isExecutingRef = useRef(isExecuting);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);

  if (!activeTab) {
    return null;
  }

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;

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
          value={activeTab.code}
          onChange={(value) => activeTab.onChange(value || '')}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
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
