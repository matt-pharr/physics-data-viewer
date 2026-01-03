/**
 * HTTP client for communicating with the Python backend server.
 */

export interface ExecuteResult {
  session_id: string;
  stdout: string;
  stderr: string;
  state: Record<string, any>;
  error: string | null;
}

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export interface CompletionResult {
  completions: CompletionItem[];
}

export class BackendClient {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(baseUrl: string = 'http://localhost:8000') {
    this.baseUrl = baseUrl;
  }

  /**
   * Connect to the backend and create a session.
   */
  async connect(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    const data = await response.json();
    this.sessionId = data.session_id;
    return this.sessionId!;
  }

  /**
   * Execute Python code on the backend.
   */
  async execute(code: string, sessionId?: string): Promise<ExecuteResult> {
    const session = sessionId || this.sessionId;
    if (!session) {
      throw new Error('No session available. Call connect() first.');
    }

    const response = await fetch(`${this.baseUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        session_id: session,
        timeout: 5.0,
      }),
    });

    if (!response.ok) {
      throw new Error(`Execution failed: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get autocomplete suggestions for the given code and cursor position.
   */
  async getCompletions(
    code: string,
    position: number,
    sessionId?: string
  ): Promise<CompletionItem[]> {
    const session = sessionId || this.sessionId;
    if (!session) {
      throw new Error('No session available. Call connect() first.');
    }

    const response = await fetch(`${this.baseUrl}/autocomplete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        position,
        session_id: session,
      }),
    });

    if (!response.ok) {
      throw new Error(`Autocomplete failed: ${response.statusText}`);
    }

    const data: CompletionResult = await response.json();
    return data.completions;
  }

  /**
   * Get the current state for the session.
   */
  async getState(sessionId?: string): Promise<Record<string, any>> {
    const session = sessionId || this.sessionId;
    if (!session) {
      throw new Error('No session available. Call connect() first.');
    }

    const response = await fetch(`${this.baseUrl}/state/${session}`);

    if (!response.ok) {
      throw new Error(`Failed to get state: ${response.statusText}`);
    }

    return await response.json();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}
