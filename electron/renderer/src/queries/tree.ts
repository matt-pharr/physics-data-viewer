/**
 * queries/tree.ts — React Query hooks and fetchers for tree listings.
 *
 * One query per listed parent path, keyed `['tree', kernelId, path]`. The
 * Tree panel mounts one query for the root plus one per expanded path, so a
 * whole-tree invalidation refetches every visible level in parallel (≈1
 * round trip of wall-clock) instead of the old serial walk. Monaco tree-path
 * completions and the safety-net poll share this cache via
 * {@link fetchTreeChildren}.
 */

import { useQueries } from '@tanstack/react-query';
import { queryClient, STALE_TIMES } from './client';
import { keys } from './keys';
import { invalidateTree } from './invalidation';
import { treeService, type TreeNodeData } from '../services/tree';

/** Safety-net poll cadence (was 1 s serial-per-level; now one parallel pass). */
export const TREE_POLL_INTERVAL_MS = 2_000;

/**
 * Freshness bar for poll-driven fetches: data refetched within this window
 * (e.g. by a push invalidation) is reused, so a poll tick right after a push
 * costs nothing.
 */
export const TREE_POLL_STALE_MS = 1_000;

/**
 * How long after a `tree.onChanged` push the poll stays quiet — a live push
 * pipeline proves the change stream works, so polling on top is redundant.
 */
export const TREE_PUSH_SUPPRESS_MS = 2_000;

/**
 * Mount one children-listing query per path.
 *
 * `notifyOnChangeProps: ['data', 'error']` keeps no-op poll ticks free: a
 * background refetch that returns structurally identical data (same object
 * identity thanks to structural sharing) notifies nothing and re-renders
 * nothing.
 *
 * @param kernelId - Active kernel, or null (queries disabled).
 * @param paths - Parent paths to list ('' = root). Order defines result order.
 * @param enabled - Master enable (false while kernel is starting).
 * @returns One query result per path, in the same order.
 */
export function useTreeChildrenQueries(
  kernelId: string | null,
  paths: readonly string[],
  enabled: boolean,
) {
  return useQueries({
    queries: paths.map((path) => ({
      queryKey: keys.tree(kernelId ?? '__no-kernel__', path),
      queryFn: () => treeService.listByPath(kernelId, path),
      enabled: enabled && kernelId !== null,
      staleTime: STALE_TIMES.tree,
      notifyOnChangeProps: ['data', 'error'] as const,
    })),
  });
}

/**
 * Fetch (or reuse fresh) children for one path through the shared cache.
 *
 * @param kernelId - Active kernel.
 * @param path - Parent path to list ('' = root).
 * @param staleTime - Freshness bar; cached data younger than this is
 *   returned without a network hop.
 * @returns The children listing.
 * @throws Whatever `window.pdv.tree.list` throws (e.g. removed path).
 */
export function fetchTreeChildren(
  kernelId: string,
  path: string,
  staleTime: number = TREE_POLL_STALE_MS,
): Promise<TreeNodeData[]> {
  return queryClient.fetchQuery({
    queryKey: keys.tree(kernelId, path),
    queryFn: () => treeService.listByPath(kernelId, path),
    staleTime,
  });
}

/**
 * Per-kernel state for the version-based poll: whether the kernel supports
 * `pdv.tree.version`, and the last version seen. Entries are tiny and never
 * need explicit cleanup.
 */
const versionPollState = new Map<string, { supported: boolean; lastVersion: number | null }>();

/**
 * One safety-net poll tick.
 *
 * Preferred path (kernels with the version channel): a single
 * `tree.getVersion` round trip; when the counter moved, invalidate every
 * cached listing so visible levels refetch in parallel. Fallback path
 * (older kernels): revalidate the root and every expanded listing through
 * the shared cache, in parallel.
 *
 * @param kernelId - Active kernel.
 * @param expandedPaths - Currently expanded paths (fallback path only).
 */
export async function pollTreeOnce(
  kernelId: string,
  expandedPaths: Iterable<string>,
): Promise<void> {
  const state = versionPollState.get(kernelId) ?? { supported: true, lastVersion: null };
  if (state.supported) {
    let version: number | null = null;
    try {
      version = await window.pdv.tree.getVersion(kernelId);
    } catch {
      version = null;
    }
    if (version !== null) {
      const changed = state.lastVersion !== null && version !== state.lastVersion;
      versionPollState.set(kernelId, { supported: true, lastVersion: version });
      if (changed) invalidateTree(kernelId);
      return;
    }
    // Feature-detect once per kernel: null means the kernel predates the
    // version channel (or the query socket is down) — poll by listing.
    versionPollState.set(kernelId, { supported: false, lastVersion: null });
  }
  await Promise.all(
    ['', ...expandedPaths].map((path) =>
      fetchTreeChildren(kernelId, path).catch(() => {
        // Path may have been removed, or the kernel may be transiently
        // unavailable — skip without disturbing the UI.
      }),
    ),
  );
}
