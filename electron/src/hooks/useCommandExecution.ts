/**
 * Custom hook for managing Python command execution.
 * Handles communication with the backend and state management.
 */

import { useState, useCallback } from 'react';

interface ExecutionResult {
  stdout: string;
  stderr: string;
  state: Record<string, any>;
  error: string | null;
}

interface ExecutionState {
  isExecuting: boolean;
  result: ExecutionResult | null;
  history: Array<{ command: string; result: ExecutionResult }>;
}

export function useCommandExecution(backendUrl: string, sessionId: string) {
  const [executionState, setExecutionState] = useState<ExecutionState>({
    isExecuting: false,
    result: null,
    history: [],
  });

  const executeCommand = useCallback(
    async (code: string): Promise<ExecutionResult> => {
      setExecutionState((prev) => ({ ...prev, isExecuting: true }));

      try {
        const response = await fetch(`${backendUrl}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            code,
            session_id: sessionId,
            timeout: 30.0,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const result: ExecutionResult = {
          stdout: data.stdout || '',
          stderr: data.stderr || '',
          state: data.state || {},
          error: data.error || null,
        };

        setExecutionState((prev) => ({
          isExecuting: false,
          result,
          history: [...prev.history, { command: code, result }],
        }));

        return result;
      } catch (error) {
        const errorResult: ExecutionResult = {
          stdout: '',
          stderr: '',
          state: {},
          error: error instanceof Error ? error.message : 'Unknown error',
        };

        setExecutionState((prev) => ({
          isExecuting: false,
          result: errorResult,
          history: [...prev.history, { command: code, result: errorResult }],
        }));

        return errorResult;
      }
    },
    [backendUrl, sessionId]
  );

  const clearHistory = useCallback(() => {
    setExecutionState((prev) => ({
      ...prev,
      history: [],
      result: null,
    }));
  }, []);

  return {
    executeCommand,
    clearHistory,
    isExecuting: executionState.isExecuting,
    currentResult: executionState.result,
    history: executionState.history,
  };
}
