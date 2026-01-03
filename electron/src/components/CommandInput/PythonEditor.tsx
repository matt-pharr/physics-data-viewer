/**
 * Python Editor component using Monaco Editor.
 * Provides syntax highlighting, command history, and autocomplete for Python code.
 */

import React, { useRef, useEffect, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { getCompletions } from '../../utils/autocompletion';

interface PythonEditorProps {
  sessionId: string;
  backendUrl?: string;
  onExecute?: (code: string) => void;
  onHistoryNavigate?: (direction: 'up' | 'down') => void;
  initialValue?: string;
  height?: string;
  width?: string;
}

interface CommandHistory {
  commands: string[];
  currentIndex: number;
}

/**
 * PythonEditor component with Monaco Editor integration.
 * 
 * Features:
 * - Syntax highlighting for Python
 * - Multi-line input support
 * - Command execution on Ctrl+Enter (Cmd+Enter on Mac)
 * - Command history navigation with Up/Down arrows
 * - Autocomplete for keywords, builtins, and state variables
 */
export const PythonEditor: React.FC<PythonEditorProps> = ({
  sessionId,
  backendUrl = 'http://localhost:8000',
  onExecute,
  onHistoryNavigate,
  initialValue = '',
  height = '200px',
  width = '100%',
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [history, setHistory] = useState<CommandHistory>({
    commands: [],
    currentIndex: -1,
  });

  /**
   * Handle Monaco editor mount.
   */
  const handleEditorDidMount = (
    editor: editor.IStandaloneCodeEditor,
    monaco: Monaco
  ) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure Python language
    monaco.languages.setLanguageConfiguration('python', {
      comments: {
        lineComment: '#',
        blockComment: ["'''", "'''"],
      },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
    });

    // Register autocomplete provider
    monaco.languages.registerCompletionItemProvider('python', {
      provideCompletionItems: async (model, position) => {
        const code = model.getValue();
        const offset = model.getOffsetAt(position);

        try {
          const completions = await getCompletions(
            sessionId,
            code,
            offset,
            backendUrl
          );

          return {
            suggestions: completions.map((completion) => ({
              label: completion,
              kind: monaco.languages.CompletionItemKind.Text,
              insertText: completion,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
            })),
          };
        } catch (error) {
          console.error('Autocomplete error:', error);
          return { suggestions: [] };
        }
      },
    });

    // Add keyboard shortcuts
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => {
        const code = editor.getValue();
        if (code.trim() && onExecute) {
          onExecute(code);
          addToHistory(code);
          editor.setValue('');
        }
      }
    );

    // Add history navigation
    editor.addCommand(monaco.KeyCode.UpArrow, () => {
      const position = editor.getPosition();
      if (position && position.lineNumber === 1) {
        navigateHistory('up');
      }
    });

    editor.addCommand(monaco.KeyCode.DownArrow, () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (model && position && position.lineNumber === model.getLineCount()) {
        navigateHistory('down');
      }
    });

    // Focus the editor
    editor.focus();
  };

  /**
   * Add a command to history.
   */
  const addToHistory = (command: string) => {
    if (!command.trim()) return;

    setHistory((prev) => {
      const newCommands = [...prev.commands];
      
      // Don't add duplicate consecutive commands
      if (newCommands.length > 0 && newCommands[newCommands.length - 1] === command) {
        return { commands: newCommands, currentIndex: -1 };
      }

      newCommands.push(command);
      
      // Limit history size to 1000 commands
      if (newCommands.length > 1000) {
        newCommands.shift();
      }

      return { commands: newCommands, currentIndex: -1 };
    });
  };

  /**
   * Navigate command history.
   */
  const navigateHistory = (direction: 'up' | 'down') => {
    if (!editorRef.current) return;

    setHistory((prev) => {
      if (prev.commands.length === 0) return prev;

      let newIndex = prev.currentIndex;

      if (direction === 'up') {
        if (newIndex === -1) {
          newIndex = prev.commands.length - 1;
        } else if (newIndex > 0) {
          newIndex--;
        }
      } else {
        if (newIndex === -1) {
          return prev;
        } else if (newIndex < prev.commands.length - 1) {
          newIndex++;
        } else {
          // Reset to empty input
          editorRef.current?.setValue('');
          return { ...prev, currentIndex: -1 };
        }
      }

      const command = prev.commands[newIndex];
      editorRef.current?.setValue(command);
      
      // Move cursor to end
      const model = editorRef.current?.getModel();
      if (model) {
        const lineCount = model.getLineCount();
        const lastLineLength = model.getLineLength(lineCount);
        editorRef.current?.setPosition({
          lineNumber: lineCount,
          column: lastLineLength + 1,
        });
      }

      if (onHistoryNavigate) {
        onHistoryNavigate(direction);
      }

      return { ...prev, currentIndex: newIndex };
    });
  };

  return (
    <div style={{ width, height, border: '1px solid #ccc' }}>
      <Editor
        height={height}
        width={width}
        language="python"
        theme="vs-dark"
        defaultValue={initialValue}
        onMount={handleEditorDidMount}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          wordWrap: 'on',
          suggest: {
            showKeywords: true,
            showSnippets: true,
          },
        }}
      />
    </div>
  );
};

export default PythonEditor;
