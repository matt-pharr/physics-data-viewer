export interface LogEntry {
  id: string;
  timestamp: number;
  code: string;
  stdout?: string;
  stderr?: string;
  result?: unknown;
  error?: string;
  duration?: number;
  images?: Array<{ mime: string; data: string }>;
}

export interface CommandTab {
  id: number;
  code: string;
}
