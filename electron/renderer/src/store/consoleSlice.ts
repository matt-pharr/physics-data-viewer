/**
 * consoleSlice.ts — console execution-history log entries.
 *
 * The log list lives in the store so only the Console panel re-renders on
 * output: App used to hold it in useState, which re-rendered the entire app
 * on every 16 ms output flush during streaming executions. `setLogs` keeps
 * the React `Dispatch<SetStateAction<...>>` shape so hooks that receive it
 * as a prop (subscriptions, note tabs, project workflow) are unchanged.
 */

import type { LogEntry } from '../types';
import type { AppSlice } from './index';

export interface ConsoleSlice {
  logs: LogEntry[];
  /** React-setter-compatible updater (accepts a value or a function). */
  setLogs: (update: LogEntry[] | ((prev: LogEntry[]) => LogEntry[])) => void;
  clearLogs: () => void;
}

export const createConsoleSlice: AppSlice<ConsoleSlice> = (set) => ({
  logs: [],
  setLogs: (update) =>
    set((state) => ({
      logs: typeof update === 'function' ? update(state.logs) : update,
    })),
  clearLogs: () => set({ logs: [] }),
});
