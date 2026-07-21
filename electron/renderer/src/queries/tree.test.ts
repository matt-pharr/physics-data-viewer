// @vitest-environment jsdom

/**
 * tree.test.ts — unit tests for the version-based safety-net poll.
 *
 * Pins the round-trip discipline: with the version channel, an idle poll
 * tick is exactly one `tree.getVersion` call (no listings); a version bump
 * invalidates cached listings; kernels without the channel are detected
 * once and polled by listing thereafter.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installPdvMock, type PdvMock } from '../test-fixtures/pdv-mock';
import { queryClient } from './client';
import { keys } from './keys';
import { pollTreeOnce } from './tree';

let pdv: PdvMock;

beforeEach(() => {
  queryClient.clear();
  pdv = installPdvMock();
});

function isStale(kernelId: string, path: string): boolean {
  const state = queryClient.getQueryState(keys.tree(kernelId, path) as unknown as unknown[]);
  if (!state) throw new Error('no query state');
  return state.isInvalidated;
}

describe('pollTreeOnce', () => {
  it('costs one getVersion call and nothing else while the version is unchanged', async () => {
    const kid = 'k-idle';
    pdv.tree.getVersion.mockResolvedValue(7);
    queryClient.setQueryData(keys.tree(kid, '') as unknown as unknown[], []);
    queryClient.setQueryData(keys.tree(kid, 'a') as unknown as unknown[], []);

    await pollTreeOnce(kid, ['a']); // baseline tick
    await pollTreeOnce(kid, ['a']); // idle tick

    expect(pdv.tree.getVersion).toHaveBeenCalledTimes(2);
    expect(pdv.tree.list).not.toHaveBeenCalled();
    expect(isStale(kid, '')).toBe(false);
    expect(isStale(kid, 'a')).toBe(false);
  });

  it('invalidates every cached listing when the version moves', async () => {
    const kid = 'k-moved';
    queryClient.setQueryData(keys.tree(kid, '') as unknown as unknown[], []);
    queryClient.setQueryData(keys.tree(kid, 'a') as unknown as unknown[], []);

    pdv.tree.getVersion.mockResolvedValueOnce(1);
    await pollTreeOnce(kid, ['a']); // baseline
    pdv.tree.getVersion.mockResolvedValueOnce(2);
    await pollTreeOnce(kid, ['a']);

    expect(isStale(kid, '')).toBe(true);
    expect(isStale(kid, 'a')).toBe(true);
    expect(pdv.tree.list).not.toHaveBeenCalled();
  });

  it('falls back to parallel listing revalidation for kernels without the channel', async () => {
    const kid = 'k-legacy';
    pdv.tree.getVersion.mockResolvedValue(null);
    pdv.tree.list.mockResolvedValue([]);

    await pollTreeOnce(kid, ['a', 'b']);
    // Root + both expanded paths were revalidated through the cache.
    expect(pdv.tree.list).toHaveBeenCalledTimes(3);

    // The unsupported result is remembered: later ticks skip getVersion.
    await pollTreeOnce(kid, ['a', 'b']);
    expect(pdv.tree.getVersion).toHaveBeenCalledTimes(1);
  });
});
