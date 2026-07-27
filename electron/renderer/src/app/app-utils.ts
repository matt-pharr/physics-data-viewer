/**
 * app-utils.ts — Pure helper functions shared across App and its hooks.
 *
 * Contains normalizers for persisted data (code cells, recent projects) and
 * config merge helpers. These are side-effect-free and have no React dependency.
 */

import type { CellTab, Config, LogEntry, RecentProjectEntry } from '../types';
import { MAX_IMAGE_LOG_ENTRIES, MAX_LOG_ENTRIES, MAX_RECENT_PROJECTS } from './constants';

/**
 * Append a console log entry, enforcing both retention caps: total entries
 * (`MAX_LOG_ENTRIES`) and how many recent entries keep their inline images
 * (`MAX_IMAGE_LOG_ENTRIES`). Entries pushed past the image window have their
 * base64 images replaced by an `imagesDropped` count; untouched entries keep
 * their identity so memoized rows don't re-render.
 *
 * @param prev - Current log entries (not mutated).
 * @param entry - The new entry to append.
 * @returns The capped log list.
 */
export function appendLogEntry(prev: LogEntry[], entry: LogEntry): LogEntry[] {
  let next = [...prev, entry];
  if (next.length > MAX_LOG_ENTRIES) {
    next = next.slice(next.length - MAX_LOG_ENTRIES);
  }
  const imageCutoff = next.length - MAX_IMAGE_LOG_ENTRIES;
  if (imageCutoff > 0) {
    for (let i = 0; i < imageCutoff; i++) {
      const old = next[i];
      if (old.images && old.images.length > 0) {
        next[i] = {
          ...old,
          images: undefined,
          imagesDropped: (old.imagesDropped ?? 0) + old.images.length,
        };
      }
    }
  }
  return next;
}

/**
 * Generate an execution ID for correlating a kernel run with its console
 * log entry and streamed output chunks. Uses `crypto.randomUUID` when
 * available with a timestamp-random fallback.
 */
export function newExecutionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Normalize persisted code-cell payloads from config/project files into a safe
 * runtime shape expected by the renderer.
 */
export function normalizeLoadedCodeCells(data: unknown): { tabs: CellTab[]; activeTabId: number } {
  const rawTabs =
    Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { tabs?: unknown }).tabs)
        ? ((data as { tabs: unknown[] }).tabs)
        : [];

  const tabs = rawTabs
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const maybe = entry as Record<string, unknown>;
      const code = typeof maybe.code === 'string' ? maybe.code : '';
      const id = typeof maybe.id === 'number' ? maybe.id : index + 1;
      const name = typeof maybe.name === 'string' ? maybe.name : undefined;
      return name ? { id, code, name } : { id, code };
    })
    .filter((tab): tab is CellTab => tab !== null);
  const normalizedTabs = tabs.length > 0 ? tabs : [{ id: 1, code: '' }];
  const requestedActive =
    data && typeof data === 'object' && typeof (data as { activeTabId?: unknown }).activeTabId === 'number'
      ? (data as { activeTabId: number }).activeTabId
      : normalizedTabs[0].id;
  const activeTabId = normalizedTabs.some((tab) => tab.id === requestedActive)
    ? requestedActive
    : normalizedTabs[0].id;
  return { tabs: normalizedTabs, activeTabId };
}

/**
 * Normalize the recent-project list (unique per host + path, trimmed, capped).
 *
 * Accepts the legacy `string[]` form — written before recents recorded which
 * host a project lives on — and treats those entries as local, so an existing
 * list survives the upgrade rather than appearing empty.
 */
export function normalizeRecentProjects(data: unknown): RecentProjectEntry[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const next: RecentProjectEntry[] = [];
  for (const raw of data) {
    let host: string | null = null;
    let rawPath: unknown;
    if (typeof raw === 'string') {
      rawPath = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entry = raw as Record<string, unknown>;
      rawPath = entry.path;
      if (typeof entry.host === 'string' && entry.host.trim()) {
        host = entry.host.trim();
      }
    } else {
      continue;
    }
    if (typeof rawPath !== 'string') continue;
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    const key = `${host ?? ''} ${trimmed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ host, path: trimmed });
    if (next.length >= MAX_RECENT_PROJECTS) break;
  }
  return next;
}

/** Whether two recent entries name the same project on the same host. */
export function isSameRecentProject(
  a: RecentProjectEntry,
  b: RecentProjectEntry,
): boolean {
  return a.host === b.host && a.path === b.path;
}

/**
 * Deep-merge a partial config update into the current config.
 *
 * Handles nested `settings` / `settings.appearance` and the `launchers`
 * subtree without requiring callers to spread every level. The `launchers`
 * merge mirrors the main-process `config:set` handler so a partial update
 * (e.g. the General tab writing only `terminal` + `editor`) doesn't drop the
 * sibling `agent` slot from the renderer's in-memory copy.
 */
export function mergeConfigUpdate(base: Config, updates: Partial<Config>): Config {
  return {
    ...base,
    ...updates,
    settings: {
      ...base.settings,
      ...updates.settings,
      appearance: {
        ...base.settings?.appearance,
        ...updates.settings?.appearance,
      },
    },
    ...(updates.launchers
      ? { launchers: { ...base.launchers, ...updates.launchers } }
      : {}),
  };
}
