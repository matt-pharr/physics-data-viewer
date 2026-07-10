// @vitest-environment jsdom

/**
 * tree.test.ts — unit tests for the renderer tree service.
 *
 * Uses the typed `installPdvMock` factory from `test-fixtures/pdv-mock` so the
 * mocked surface stays in sync with the real `PDVApi` contract. The service is
 * deliberately uncached — every call fetches fresh and returns new objects —
 * so these tests pin the enrichment mapping and the fresh-objects contract.
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads root nodes with default UI state', async () => {
    const nodes = await treeService.getRootNodes('k1');

    expect(nodes).toHaveLength(rootNodes.length);
    expect(nodes[0].isExpanded).toBe(false);
    expect(nodes[0].isLoading).toBe(false);
    expect(nodes[0].hasChildren).toBe(true);
    expect(nodes[0].parentPath).toBeNull();
  });

  it('returns fresh objects on every call (no shared/cached state)', async () => {
    const first = await treeService.getRootNodes('k1');
    // Callers tag UI state onto results; a second fetch must not see it.
    first[0].isExpanded = true;

    const second = await treeService.getRootNodes('k1');

    expect(pdv.tree.list).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].isExpanded).toBe(false);
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

  it('loads children by parent node path', async () => {
    const parent = { ...rootNodes[0], hasChildren: true, parentPath: null };

    const children = await treeService.getChildren(
      parent as unknown as Parameters<typeof treeService.getChildren>[0],
      'k1',
    );

    expect(children[0].path).toBe('data.array1');
  });

  it('returns empty for a null kernel id', async () => {
    expect(await treeService.getRootNodes(null)).toEqual([]);
    expect(await treeService.listByPath(null, 'data')).toEqual([]);
    expect(pdv.tree.list).not.toHaveBeenCalled();
  });
});
