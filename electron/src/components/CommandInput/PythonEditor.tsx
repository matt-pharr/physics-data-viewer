import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import type * as monacoEditor from 'monaco-editor';
import { BackendClient, CompletionItem } from '../../api/client';
import { CommandHistory } from '../../utils/commandHistory';

interface PythonEditorProps {
  onExecute: (code: string) => void;
  client: BackendClient;
  height?: string;
  placeholder?: string;
}

export const PythonEditor: React.FC<PythonEditorProps> = ({
  onExecute,
  client,
  height = '150px',
  placeholder = '# Enter Python code here...',
}) => {
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const historyRef = useRef(new CommandHistory());
  const [isNavigatingHistory, setIsNavigatingHistory] = useState(false);

  const handleEditorDidMount = useCallback(
    (editor: monacoEditor.editor.IStandaloneCodeEditor, monaco: Monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Set up Python language configuration
      monaco.languages.setLanguageConfiguration('python', {
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

      // Register custom completion provider
      monaco.languages.registerCompletionItemProvider('python', {
        provideCompletionItems: async (model: monacoEditor.editor.ITextModel, position: monacoEditor.Position) => {
          const code = model.getValue();
          const offset = model.getOffsetAt(position);

          try {
            const completions = await client.getCompletions(code, offset);
            
            const suggestions = completions.map((item: CompletionItem) => ({
              label: item.label,
              kind: getMonacoCompletionKind(monaco, item.kind),
              insertText: item.insertText || item.label,
              detail: item.detail,
              documentation: item.documentation,
            }));

            return { suggestions };
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
          handleExecute();
        }
      );

      // Handle up/down arrow keys for history navigation
      editor.addCommand(
        monaco.KeyCode.UpArrow,
        () => {
          const position = editor.getPosition();
          if (position && position.lineNumber === 1) {
            navigateHistoryBackward();
          } else {
            // Let default behavior handle cursor movement
            editor.trigger('keyboard', 'cursorUp', {});
          }
        }
      );

      editor.addCommand(
        monaco.KeyCode.DownArrow,
        () => {
          const model = editor.getModel();
          const position = editor.getPosition();
          if (model && position && position.lineNumber === model.getLineCount()) {
            navigateHistoryForward();
          } else {
            // Let default behavior handle cursor movement
            editor.trigger('keyboard', 'cursorDown', {});
          }
        }
      );

      // Focus the editor
      editor.focus();
    },
    [client]
  );

  const handleExecute = useCallback(() => {
    if (!editorRef.current) return;

    const code = editorRef.current.getValue();
    if (code.trim()) {
      historyRef.current.add(code);
      onExecute(code);
      editorRef.current.setValue('');
      setIsNavigatingHistory(false);
    }
  }, [onExecute]);

  const navigateHistoryBackward = useCallback(() => {
    if (!editorRef.current) return;

    const currentCode = editorRef.current.getValue();
    const previousCommand = historyRef.current.previous(currentCode);
    
    if (previousCommand !== null) {
      editorRef.current.setValue(previousCommand);
      setIsNavigatingHistory(true);
      
      // Move cursor to end
      const model = editorRef.current.getModel();
      if (model) {
        const lineCount = model.getLineCount();
        const lineLength = model.getLineLength(lineCount);
        editorRef.current.setPosition({ lineNumber: lineCount, column: lineLength + 1 });
      }
    }
  }, []);

  const navigateHistoryForward = useCallback(() => {
    if (!editorRef.current) return;

    const nextCommand = historyRef.current.next();
    
    if (nextCommand !== null) {
      editorRef.current.setValue(nextCommand);
      
      // Move cursor to end
      const model = editorRef.current.getModel();
      if (model) {
        const lineCount = model.getLineCount();
        const lineLength = model.getLineLength(lineCount);
        editorRef.current.setPosition({ lineNumber: lineCount, column: lineLength + 1 });
      }
    } else {
      setIsNavigatingHistory(false);
    }
  }, []);

  return (
    <div style={{ border: '1px solid #ccc', borderRadius: '4px', overflow: 'hidden' }}>
      <Editor
        height={height}
        defaultLanguage="python"
        defaultValue=""
        theme="vs-dark"
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
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'on',
        }}
      />
      <div
        style={{
          padding: '8px',
          backgroundColor: '#1e1e1e',
          color: '#888',
          fontSize: '12px',
          borderTop: '1px solid #333',
        }}
      >
        Press <kbd>Ctrl+Enter</kbd> to execute | <kbd>↑</kbd>/<kbd>↓</kbd> to navigate history
      </div>
    </div>
  );
};

/**
 * Map our completion kind to Monaco's completion item kind.
 */
function getMonacoCompletionKind(monaco: Monaco, kind: string): number {
  const CompletionItemKind = monaco.languages.CompletionItemKind;
  
  switch (kind) {
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'variable':
      return CompletionItemKind.Variable;
    case 'function':
      return CompletionItemKind.Function;
    case 'method':
      return CompletionItemKind.Method;
    case 'class':
      return CompletionItemKind.Class;
    case 'module':
      return CompletionItemKind.Module;
    default:
      return CompletionItemKind.Text;
  }
}
