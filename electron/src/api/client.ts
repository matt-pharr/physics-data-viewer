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

export interface MethodInfo {
  name: string;
  doc?: string | null;
  requires_arguments: boolean;
}

export interface InvokeResult {
  method_name: string;
  result: any;
  result_type: string;
  error?: string | null;
  traceback?: string | null;
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
  async connect(existingSessionId?: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: existingSessionId }),
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

  /**
   * Get the serialized global ProjectTree.
   */
  async getProjectTree(): Promise<Record<string, any>> {
    const response = await fetch(`${this.baseUrl}/project-tree`);
    if (!response.ok) {
      throw new Error(`Failed to get project tree: ${response.statusText}`);
    }
    return await response.json();
  }

  /**
   * List available methods for a value at the provided backend path.
   */
  async listMethods(sessionId: string, path: string[]): Promise<MethodInfo[]> {
    const response = await fetch(`${this.baseUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, path }),
    });

    if (!response.ok) {
      throw new Error(`Introspection failed: ${response.statusText}`);
    }

    const data = await response.json();
    return (data.methods || []).map((entry: any) => ({
      name: entry.name,
      doc: entry.doc,
      requires_arguments: Boolean(entry.requires_arguments),
    }));
  }

  /**
   * Invoke a zero-argument method for a backend path.
   */
  async invokeMethod(sessionId: string, path: string[], methodName: string): Promise<InvokeResult> {
    const response = await fetch(`${this.baseUrl}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, path, method_name: methodName }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const detail = payload?.detail ?? response.statusText;
      throw new Error(`Invoke failed: ${detail}`);
    }

    const data = await response.json();
    return {
      method_name: data.method_name ?? methodName,
      result: data.result,
      result_type: data.result_type ?? 'object',
      error: data.error,
      traceback: data.traceback,
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}
