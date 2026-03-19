/**
 * tree.test.ts — unit tests for renderer tree service caching behavior.
 *
 * Uses a mocked preload API (`window.pdv.tree`) to validate cache semantics
 * without requiring an Electron runtime.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor } from '../types/pdv';
import { treeService } from './tree';

const rootNodes: NodeDescriptor[] = [
  { id: 'data', key: 'data', path: 'data', parent_path: null, type: 'folder', has_children: true, lazy: false },
  { id: 'scripts', key: 'scripts', path: 'scripts', parent_path: null, type: 'folder', has_children: true, lazy: false },
];

const childNodes: NodeDescriptor[] = [
  {
    id: 'data.array1',
    key: 'array1',
    path: 'data.array1',
    parent_path: 'data',
    type: 'ndarray',
    has_children: false,
    lazy: false,
  },
];

const originalWindow = globalThis.window;

describe('treeService', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', {
      value: {} as Window,
      writable: true,
    });
  });

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock window.pdv for tests
    (globalThis.window as any).pdv = {
      tree: {
        list: vi.fn(async (_kernelId?: string, path?: string) => {
          if (!path || path === '') {
            return rootNodes;
          }
          if (path === 'data') {
            return childNodes;
          }
          return [];
        }),
        get: vi.fn(async () => ({ path: 'data.lazy', value: 'loaded' })),
        createScript: vi.fn(async () => ({ success: true })),
      },
    };

    treeService.clearCache();
  });

  it('loads and caches root nodes', async () => {
    const first = await treeService.getRootNodes('k1');
    const second = await treeService.getRootNodes('k1');

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first).toHaveLength(rootNodes.length);
    expect(first[0].isExpanded).toBe(false);
    expect(first[0].isLoading).toBe(false);
  });

  it('returns empty array when node has no children', async () => {
    const node = { ...childNodes[0], isExpanded: false, isLoading: false };
    const result = await treeService.getChildren(node, 'k1');

    expect(result).toEqual([]);
    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);
    expect(listMock).not.toHaveBeenCalledWith(node.path);
  });

  it('loads and caches children by path', async () => {
    const parent = { ...rootNodes[0], hasChildren: true, parentPath: null };

    const first = await treeService.getChildren(parent, 'k1');
    const second = await treeService.getChildren(parent, 'k1');

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first[0].path).toBe('data.array1');
  });

  it('maintains cache per kernel', async () => {
    const parent = { ...rootNodes[0], hasChildren: true, parentPath: null };
    await treeService.getChildren(parent, 'k1');
    await treeService.getChildren(parent, 'k2');

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('eager-loads lazy children and refreshes listing', async () => {
    const listMock = window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>;
    const getMock = window.pdv.tree.get as unknown as ReturnType<typeof vi.fn>;
    const parent = { ...rootNodes[0], hasChildren: true, parentPath: null };
    listMock.mockImplementation(async (_kernelId?: string, path?: string) => {
      if (path === 'data') {
        if (getMock.mock.calls.length === 0) {
          return [
            {
              id: 'data.lazy',
              key: 'lazy',
              path: 'data.lazy',
              parent_path: 'data',
              type: 'unknown',
              has_children: false,
              lazy: true,
            },
          ];
        }
        return childNodes;
      }
      return [];
    });

    const children = await treeService.getChildren(parent, 'k1', {
      force: true,
      eagerLoadLazy: true,
    });

    expect(getMock).toHaveBeenCalledWith('k1', 'data.lazy');
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(children[0].path).toBe('data.array1');
    expect(children[0].lazy).toBe(false);
  });

  afterAll(() => {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      writable: true,
    });
  });
});
