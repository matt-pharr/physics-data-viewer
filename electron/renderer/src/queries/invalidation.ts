/**
 * invalidation.ts — the single mapping from "something changed" to React
 * Query cache invalidation.
 *
 * Push handlers (owned by App's useKernelSubscriptions) and mutation call
 * sites call these functions instead of bumping refresh tokens. All
 * invalidations are active-only (`refetchType: 'active'`): stale-but-inactive
 * queries refetch lazily when their component mounts, so an invalidation
 * never costs round trips for panels the user isn't looking at.
 *
 * This module is also the designated reconnect hook: when a remote session
 * reattaches with a sequence gap (Phase 3), the reconnect handler calls
 * `invalidateAllKernelState(kernelId, 'reconnect')` here and nothing else.
 */

import { queryClient } from './client';
import { keys, isKernelScopedKey } from './keys';
import type { TreeChangeInfo } from '../types';
import type { TreeNodeData } from '../services/tree';

/** Why a whole-kernel invalidation is happening; logged for diagnosis. */
export type KernelInvalidationReason = 'kernel-switch' | 'project-load' | 'reconnect';

/** Wall-clock of the most recent `tree.onChanged` push (0 = never). */
let lastTreePushAt = 0;

/** Record that a tree push just arrived (suppresses the safety-net poll). */
export function noteTreePushActivity(): void {
  lastTreePushAt = Date.now();
}

/** Milliseconds since the last tree push (Infinity if none yet). */
export function msSinceTreePush(): number {
  return lastTreePushAt === 0 ? Infinity : Date.now() - lastTreePushAt;
}

/**
 * Parent path of a dot-separated tree path ('' for top-level entries).
 *
 * @param path - Absolute tree path like 'a.b.c'.
 * @returns 'a.b' for 'a.b.c'; '' for 'a'.
 */
export function parentTreePath(path: string): string {
  const dotIdx = path.lastIndexOf('.');
  return dotIdx > 0 ? path.substring(0, dotIdx) : '';
}

/**
 * Translate one `tree.onChanged` push into targeted cache updates.
 *
 * - 'removed': drop the node from its parent's cached listing immediately
 *   (0 round trips), purge cached listings under the removed subtree, then
 *   invalidate the parent as reconciliation.
 * - 'added' | 'updated' | 'batch': invalidate each changed path's parent
 *   listing (active-only — unexpanded parents refetch lazily on expansion).
 * - 'unknown' (non-root PDVTree mutation, unmappable path): invalidate every
 *   listing for the kernel; active ones refetch in parallel.
 *
 * @param kernelId - Kernel the push came from.
 * @param change - The push payload.
 */
export function applyTreeChange(kernelId: string, change: TreeChangeInfo): void {
  noteTreePushActivity();
  if (change.change_type === 'unknown') {
    invalidateTree(kernelId);
    return;
  }
  if (change.change_type === 'removed') {
    for (const removed of change.changed_paths) {
      const parent = parentTreePath(removed);
      queryClient.setQueryData<TreeNodeData[]>(
        keys.tree(kernelId, parent),
        (old) => old?.filter((n) => n.path !== removed),
      );
      queryClient.removeQueries({
        predicate: (query) => {
          const k = query.queryKey;
          return (
            k[0] === 'tree' &&
            k[1] === kernelId &&
            typeof k[2] === 'string' &&
            (k[2] === removed || k[2].startsWith(`${removed}.`))
          );
        },
      });
      invalidateTree(kernelId, parent);
    }
    return;
  }
  const parents = new Set(change.changed_paths.map(parentTreePath));
  for (const parent of parents) {
    invalidateTree(kernelId, parent);
  }
}

/**
 * Invalidate tree listings for a kernel — one parent path, or all of them.
 *
 * @param kernelId - Kernel whose tree cache is stale.
 * @param path - Parent path whose children changed; omit to invalidate every
 *   cached listing (root + all expanded, refetched in parallel).
 */
export function invalidateTree(kernelId: string, path?: string): void {
  void queryClient.invalidateQueries({
    queryKey: path === undefined ? keys.treeAll(kernelId) : keys.tree(kernelId, path),
    refetchType: 'active',
  });
}

/**
 * Invalidate namespace state (top-level query and expanded-node inspections).
 *
 * @param kernelId - Kernel whose namespace changed (typically post-execution).
 */
export function invalidateNamespace(kernelId: string): void {
  void queryClient.invalidateQueries({
    queryKey: keys.namespaceAll(kernelId),
    refetchType: 'active',
  });
  void queryClient.invalidateQueries({
    queryKey: keys.namespaceInspectAll(kernelId),
    refetchType: 'active',
  });
}

/**
 * Invalidate module listings for a kernel.
 *
 * @param kernelId - Kernel whose imported/available modules changed.
 */
export function invalidateModules(kernelId: string): void {
  void queryClient.invalidateQueries({
    queryKey: keys.modulesAll(kernelId),
    refetchType: 'active',
  });
}

/**
 * Invalidate Monaco completion/hover caches — the kernel namespace changed,
 * so cached completions and inspections are stale.
 *
 * @param kernelId - Kernel that finished executing.
 */
export function invalidateCompletions(kernelId: string): void {
  void queryClient.invalidateQueries({ queryKey: keys.completionAll(kernelId) });
  void queryClient.invalidateQueries({ queryKey: keys.inspectHoverAll(kernelId) });
}

/**
 * Invalidate or drop everything scoped to a kernel.
 *
 * 'kernel-switch' removes queries outright (no refetch storm for a kernel
 * that is going away); 'project-load' and 'reconnect' invalidate active
 * queries so visible panels refetch in parallel.
 *
 * @param kernelId - Kernel whose state is affected.
 * @param reason - What happened; controls remove-vs-invalidate.
 */
export function invalidateAllKernelState(
  kernelId: string,
  reason: KernelInvalidationReason,
): void {
  if (reason === 'kernel-switch') {
    queryClient.removeQueries({
      predicate: (query) => isKernelScopedKey(query.queryKey, kernelId),
    });
    return;
  }
  void queryClient.invalidateQueries({
    predicate: (query) => isKernelScopedKey(query.queryKey, kernelId),
    refetchType: 'active',
  });
}
