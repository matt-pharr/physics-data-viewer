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
        list: vi.fn(async (_kernelId?: string, path?: string) => {
          if (!path || path === '') {
            return rootNodes;
          }
          if (path === 'data') {
            return childNodes;
          }
          return [];
        }),
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
    const parent = { ...rootNodes[0] };

    const first = await treeService.getChildren(parent, 'k1');
    const second = await treeService.getChildren(parent, 'k1');

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first[0].path).toBe('data.array1');
  });

  it('maintains cache per kernel', async () => {
    const parent = { ...rootNodes[0] };
    await treeService.getChildren(parent, 'k1');
    await treeService.getChildren(parent, 'k2');

    const listMock = (window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('creates script and clears cache', async () => {
    const createMock = window.pdv.tree.createScript as unknown as ReturnType<typeof vi.fn>;
    await treeService.getRootNodes('k1');
    await treeService.createScript('k1', 'scripts', 'demo');

    expect(createMock).toHaveBeenCalledWith('k1', 'scripts', 'demo');
    const listMock = window.pdv.tree.list as unknown as ReturnType<typeof vi.fn>;
    expect(listMock).toHaveBeenCalledTimes(1);
  });
  afterAll(() => {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      writable: true,
    });
  });
});
