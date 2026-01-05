import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../../main/ipc';
import { treeService } from './tree';

const rootNodes: TreeNode[] = [
  { id: 'data', key: 'data', path: 'data', type: 'folder', hasChildren: true },
  { id: 'scripts', key: 'scripts', path: 'scripts', type: 'folder', hasChildren: true },
];

const childNodes: TreeNode[] = [
  { id: 'data.array1', key: 'array1', path: 'data.array1', type: 'ndarray', hasChildren: false },
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
    (globalThis.window as any).pdv = {
      tree: {
        list: vi.fn(async (path?: string) => {
          if (!path || path === '') {
            return rootNodes;
          }
          if (path === 'data') {
            return childNodes;
          }
          return [];
        }),
      },
    };

    treeService.clearCache();
  });

  it('loads and caches root nodes', async () => {
    const first = await treeService.getRootNodes();
    const second = await treeService.getRootNodes();

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first).toHaveLength(rootNodes.length);
    expect(first[0].isExpanded).toBe(false);
    expect(first[0].isLoading).toBe(false);
  });

  it('returns empty array when node has no children', async () => {
    const node = { ...childNodes[0], isExpanded: false, isLoading: false };
    const result = await treeService.getChildren(node);

    expect(result).toEqual([]);
    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);
    expect(listMock).not.toHaveBeenCalledWith(node.path);
  });

  it('loads and caches children by path', async () => {
    const parent = { ...rootNodes[0], hasChildren: true };

    const first = await treeService.getChildren(parent);
    const second = await treeService.getChildren(parent);

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first[0].path).toBe('data.array1');
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    writable: true,
  });
});
