/**
 * app-utils.ts — Pure helper functions shared across App and its hooks.
 *
 * Contains normalizers for persisted data (code cells, recent projects) and
 * config merge helpers. These are side-effect-free and have no React dependency.
 */

import type { CellTab } from '../types';

/** Maximum recent projects to retain. */
const MAX_RECENT_PROJECTS = 10;

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
      return { id, code };
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

/** Normalize the recent-project list (unique, trimmed, capped). */
export function normalizeRecentProjects(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const unique = new Set<string>();
  const next: string[] = [];
  for (const entry of data) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || unique.has(trimmed)) continue;
    unique.add(trimmed);
    next.push(trimmed);
    if (next.length >= MAX_RECENT_PROJECTS) break;
  }
  return next;
}
