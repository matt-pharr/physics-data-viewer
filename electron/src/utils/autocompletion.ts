/**
 * Autocompletion utilities for Python code.
 * Provides client-side autocomplete logic and backend integration.
 */

/**
 * Fetch autocomplete suggestions from the backend.
 * 
 * @param sessionId - The current session ID
 * @param code - The code to autocomplete
 * @param cursorPosition - The cursor position in the code
 * @param backendUrl - The backend server URL
 * @returns Array of completion suggestions
 */
export async function getCompletions(
  sessionId: string,
  code: string,
  cursorPosition?: number,
  backendUrl: string = 'http://localhost:8000'
): Promise<string[]> {
  try {
    const requestBody: {
      session_id: string;
      code: string;
      cursor_position?: number;
    } = {
      session_id: sessionId,
      code: code,
    };

    if (cursorPosition !== undefined) {
      requestBody.cursor_position = cursorPosition;
    }

    const response = await fetch(`${backendUrl}/autocomplete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      console.error('Autocomplete request failed:', response.statusText);
      return [];
    }

    const data = await response.json();
    return data.completions || [];
  } catch (error) {
    console.error('Error fetching completions:', error);
    return [];
  }
}

/**
 * Get the word at the cursor position.
 * Helper function for local completion filtering.
 * 
 * @param code - The code string
 * @param position - Cursor position
 * @returns Object containing the word and its start position
 */
export function getWordAtPosition(
  code: string,
  position: number
): { word: string; start: number } {
  if (position === 0) {
    return { word: '', start: 0 };
  }

  let start = position - 1;
  while (start >= 0) {
    const char = code[start];
    if (!isIdentifierChar(char)) {
      start++;
      break;
    }
    start--;
  }

  if (start < 0) {
    start = 0;
  }

  const word = code.substring(start, position);
  return { word, start };
}

/**
 * Check if a character is valid in a Python identifier.
 * 
 * @param char - Character to check
 * @returns True if the character is valid in an identifier
 */
function isIdentifierChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

/**
 * Filter completions based on a prefix.
 * Client-side filtering for better responsiveness.
 * 
 * @param completions - Array of completion strings
 * @param prefix - Prefix to filter by
 * @returns Filtered array of completions
 */
export function filterCompletions(
  completions: string[],
  prefix: string
): string[] {
  if (!prefix) {
    return completions;
  }

  return completions.filter((completion) =>
    completion.toLowerCase().startsWith(prefix.toLowerCase())
  );
}

/**
 * Get local Python keywords for immediate suggestions.
 * Useful as fallback when backend is unavailable.
 * 
 * @returns Array of Python keywords
 */
export function getPythonKeywords(): string[] {
  return [
    'False',
    'None',
    'True',
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
  ];
}

/**
 * Get common Python builtins for immediate suggestions.
 * Useful as fallback when backend is unavailable.
 * 
 * @returns Array of common Python builtins
 */
export function getPythonBuiltins(): string[] {
  return [
    'abs',
    'all',
    'any',
    'bin',
    'bool',
    'chr',
    'dict',
    'dir',
    'enumerate',
    'filter',
    'float',
    'format',
    'help',
    'hex',
    'int',
    'isinstance',
    'len',
    'list',
    'map',
    'max',
    'min',
    'open',
    'ord',
    'print',
    'range',
    'repr',
    'reversed',
    'round',
    'set',
    'sorted',
    'str',
    'sum',
    'tuple',
    'type',
    'zip',
  ];
}
