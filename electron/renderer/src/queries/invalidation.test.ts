/**
 * invalidation.test.ts — unit tests for the query-key factory and the
 * invalidation helpers against a real QueryClient.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { queryClient } from './client';
import { keys, isKernelScopedKey } from './keys';
import {
  invalidateTree,
  invalidateNamespace,
  invalidateModules,
  invalidateCompletions,
  invalidateAllKernelState,
  applyTreeChange,
  parentTreePath,
} from './invalidation';

const K1 = 'kernel-1';
const K2 = 'kernel-2';

/** Seed the cache with fresh data under the given key. */
function seed(queryKey: readonly unknown[]): void {
  queryClient.setQueryData(queryKey as unknown[], { seeded: true });
}

function isStale(queryKey: readonly unknown[]): boolean {
  const state = queryClient.getQueryState(queryKey as unknown[]);
  if (!state) throw new Error(`no query state for ${JSON.stringify(queryKey)}`);
  return state.isInvalidated;
}

beforeEach(() => {
  queryClient.clear();
});

describe('keys', () => {
  it('scopes kernel domains at index 1', () => {
    expect(isKernelScopedKey(keys.tree(K1, 'a.b'), K1)).toBe(true);
    expect(isKernelScopedKey(keys.tree(K1, 'a.b'), K2)).toBe(false);
    expect(isKernelScopedKey(keys.namespaceInspect(K1, "df['col']"), K1)).toBe(true);
    expect(isKernelScopedKey(['not-a-domain', K1], K1)).toBe(false);
  });
});

describe('invalidateTree', () => {
  it('invalidates one parent path without touching siblings or other kernels', () => {
    seed(keys.tree(K1, ''));
    seed(keys.tree(K1, 'a'));
    seed(keys.tree(K1, 'b'));
    seed(keys.tree(K2, 'a'));

    invalidateTree(K1, 'a');

    expect(isStale(keys.tree(K1, 'a'))).toBe(true);
    expect(isStale(keys.tree(K1, ''))).toBe(false);
    expect(isStale(keys.tree(K1, 'b'))).toBe(false);
    expect(isStale(keys.tree(K2, 'a'))).toBe(false);
  });

  it('invalidates every listing for the kernel when path is omitted', () => {
    seed(keys.tree(K1, ''));
    seed(keys.tree(K1, 'a'));
    seed(keys.tree(K2, ''));

    invalidateTree(K1);

    expect(isStale(keys.tree(K1, ''))).toBe(true);
    expect(isStale(keys.tree(K1, 'a'))).toBe(true);
    expect(isStale(keys.tree(K2, ''))).toBe(false);
  });
});

describe('invalidateNamespace / invalidateModules / invalidateCompletions', () => {
  it('covers both namespace domains', () => {
    seed(keys.namespace(K1, 'h'));
    seed(keys.namespaceInspect(K1, "df['col']"));
    seed(keys.tree(K1, ''));

    invalidateNamespace(K1);

    expect(isStale(keys.namespace(K1, 'h'))).toBe(true);
    expect(isStale(keys.namespaceInspect(K1, "df['col']"))).toBe(true);
    expect(isStale(keys.tree(K1, ''))).toBe(false);
  });

  it('targets module listings only', () => {
    seed(keys.modulesImported(K1));
    seed(keys.tree(K1, ''));

    invalidateModules(K1);

    expect(isStale(keys.modulesImported(K1))).toBe(true);
    expect(isStale(keys.tree(K1, ''))).toBe(false);
  });

  it('covers completion and hover caches', () => {
    seed(keys.completion(K1, 'ctx'));
    seed(keys.inspectHover(K1, 'expr'));

    invalidateCompletions(K1);

    expect(isStale(keys.completion(K1, 'ctx'))).toBe(true);
    expect(isStale(keys.inspectHover(K1, 'expr'))).toBe(true);
  });
});

describe('parentTreePath', () => {
  it('returns the dot-parent, or root for top-level paths', () => {
    expect(parentTreePath('a.b.c')).toBe('a.b');
    expect(parentTreePath('a')).toBe('');
  });
});

describe('applyTreeChange', () => {
  const node = (path: string) => ({ path, key: path.split('.').at(-1) });

  it("'removed' drops the node from its parent listing, purges the subtree, and invalidates the parent", () => {
    seed(keys.tree(K1, 'a')); // parent listing
    queryClient.setQueryData(keys.tree(K1, 'a') as unknown as unknown[], [node('a.b'), node('a.c')]);
    seed(keys.tree(K1, 'a.b'));
    seed(keys.tree(K1, 'a.b.deep'));
    seed(keys.tree(K1, 'a.bogus')); // similarly-prefixed sibling must survive

    applyTreeChange(K1, { changed_paths: ['a.b'], change_type: 'removed' });

    expect(queryClient.getQueryData(keys.tree(K1, 'a') as unknown as unknown[])).toEqual([node('a.c')]);
    expect(queryClient.getQueryState(keys.tree(K1, 'a.b') as unknown as unknown[])).toBeUndefined();
    expect(queryClient.getQueryState(keys.tree(K1, 'a.b.deep') as unknown as unknown[])).toBeUndefined();
    expect(queryClient.getQueryState(keys.tree(K1, 'a.bogus') as unknown as unknown[])).toBeDefined();
    expect(isStale(keys.tree(K1, 'a'))).toBe(true);
  });

  it("'added'/'updated' invalidate only the changed parents", () => {
    seed(keys.tree(K1, ''));
    seed(keys.tree(K1, 'a'));
    seed(keys.tree(K1, 'b'));

    applyTreeChange(K1, { changed_paths: ['a.x', 'a.y', 'top'], change_type: 'added' });

    expect(isStale(keys.tree(K1, 'a'))).toBe(true);
    expect(isStale(keys.tree(K1, ''))).toBe(true); // parent of 'top'
    expect(isStale(keys.tree(K1, 'b'))).toBe(false);
  });

  it("'unknown' invalidates every listing for the kernel", () => {
    seed(keys.tree(K1, ''));
    seed(keys.tree(K1, 'a'));
    seed(keys.tree(K2, ''));

    applyTreeChange(K1, { changed_paths: [], change_type: 'unknown' });

    expect(isStale(keys.tree(K1, ''))).toBe(true);
    expect(isStale(keys.tree(K1, 'a'))).toBe(true);
    expect(isStale(keys.tree(K2, ''))).toBe(false);
  });
});

describe('invalidateAllKernelState', () => {
  it("removes the kernel's queries outright on kernel-switch", () => {
    seed(keys.tree(K1, ''));
    seed(keys.namespace(K1, 'h'));
    seed(keys.tree(K2, ''));

    invalidateAllKernelState(K1, 'kernel-switch');

    expect(queryClient.getQueryState(keys.tree(K1, '') as unknown as unknown[])).toBeUndefined();
    expect(queryClient.getQueryState(keys.namespace(K1, 'h') as unknown as unknown[])).toBeUndefined();
    expect(queryClient.getQueryData(keys.tree(K2, '') as unknown as unknown[])).toEqual({ seeded: true });
  });

  it('invalidates (not removes) on reconnect', () => {
    seed(keys.tree(K1, ''));
    seed(keys.namespaceInspect(K1, 'df'));
    seed(keys.tree(K2, ''));

    invalidateAllKernelState(K1, 'reconnect');

    expect(isStale(keys.tree(K1, ''))).toBe(true);
    expect(isStale(keys.namespaceInspect(K1, 'df'))).toBe(true);
    expect(isStale(keys.tree(K2, ''))).toBe(false);
  });
});
