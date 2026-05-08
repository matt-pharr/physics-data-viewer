// @vitest-environment jsdom

/**
 * tree.test.ts — unit tests for renderer tree service caching behavior.
 *
 * Uses the typed `installPdvMock` factory from `test-fixtures/pdv-mock` so the
 * mocked surface stays in sync with the real `PDVApi` contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor, PDVApi } from '../types/pdv';
import { installPdvMock, type PdvMock } from '../test-fixtures/pdv-mock';
import { treeService } from './tree';

const rootNodes: NodeDescriptor[] = [
  { id: 'data', key: 'data', path: 'data', parent_path: null, type: 'folder', has_children: true },
  { id: 'scripts', key: 'scripts', path: 'scripts', parent_path: null, type: 'folder', has_children: true },
];

const childNodes: NodeDescriptor[] = [
  {
    id: 'data.array1',
    key: 'array1',
    path: 'data.array1',
    parent_path: 'data',
    type: 'ndarray',
    has_children: false,
  },
];

describe('treeService', () => {
  let pdv: PdvMock;

  beforeEach(() => {
    pdv = installPdvMock({
      tree: {
        list: vi.fn<PDVApi['tree']['list']>(async (_kernelId, path) => {
          if (!path || path === '') return rootNodes;
          if (path === 'data') return childNodes;
          return [];
        }),
      },
    });

    treeService.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and caches root nodes', async () => {
    const first = await treeService.getRootNodes('k1');
    const second = await treeService.getRootNodes('k1');

    expect(pdv.tree.list).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first).toHaveLength(rootNodes.length);
    expect(first[0].isExpanded).toBe(false);
    expect(first[0].isLoading).toBe(false);
  });

  it('returns empty array when node has no children', async () => {
    const node = {
      ...childNodes[0],
      hasChildren: Boolean(childNodes[0].has_children),
      parentPath: childNodes[0].parent_path ?? null,
      isExpanded: false,
      isLoading: false,
    } as unknown as Parameters<typeof treeService.getChildren>[0];
    const result = await treeService.getChildren(node, 'k1');

    expect(result).toEqual([]);
    expect(pdv.tree.list).not.toHaveBeenCalledWith(node.path);
  });

  it('loads and caches children by path', async () => {
    const parent = { ...rootNodes[0], hasChildren: true, parentPath: null };

    const first = await treeService.getChildren(parent, 'k1');
    const second = await treeService.getChildren(parent, 'k1');

    expect(pdv.tree.list).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first[0].path).toBe('data.array1');
  });

  it('maintains cache per kernel', async () => {
    const parent = { ...rootNodes[0], hasChildren: true, parentPath: null };
    await treeService.getChildren(parent, 'k1');
    await treeService.getChildren(parent, 'k2');

    expect(pdv.tree.list).toHaveBeenCalledTimes(2);
  });
});
