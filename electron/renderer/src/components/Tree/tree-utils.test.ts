import { describe, expect, it } from 'vitest';
import type { TreeNodeData } from '../../types';
import { findNode, flattenTree, updateNodeImmut } from './tree-utils';

function makeNode(
  path: string,
  overrides: Partial<TreeNodeData> = {},
): TreeNodeData {
  const key = path.includes('.') ? path.split('.').at(-1) ?? path : path;
  const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null;
  return {
    id: path,
    key,
    path,
    parent_path: parent,
    type: 'folder',
    has_children: false,
    hasChildren: false,
    parentPath: parent,
    ...overrides,
  };
}

describe('flattenTree', () => {
  it('returns empty list for empty input', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('returns flat nodes at depth 0', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const result = flattenTree(nodes);
    expect(result).toHaveLength(2);
    expect(result[0].depth).toBe(0);
    expect(result[1].depth).toBe(0);
    expect(result.map((n) => n.path)).toEqual(['a', 'b']);
  });

  it('includes expanded children and omits collapsed children', () => {
    const expanded = makeNode('a', {
      isExpanded: true,
      children: [makeNode('a.x')],
    });
    const collapsed = makeNode('b', {
      isExpanded: false,
      children: [makeNode('b.y')],
    });
    const result = flattenTree([expanded, collapsed]);
    expect(result.map((n) => n.path)).toEqual(['a', 'a.x', 'b']);
    expect(result.find((n) => n.path === 'a.x')?.depth).toBe(1);
  });

  it('computes nested depths correctly', () => {
    const nested = makeNode('root', {
      isExpanded: true,
      children: [
        makeNode('root.child', {
          isExpanded: true,
          children: [makeNode('root.child.leaf')],
        }),
      ],
    });
    const result = flattenTree([nested]);
    expect(result.find((n) => n.path === 'root')?.depth).toBe(0);
    expect(result.find((n) => n.path === 'root.child')?.depth).toBe(1);
    expect(result.find((n) => n.path === 'root.child.leaf')?.depth).toBe(2);
  });
});

describe('findNode', () => {
  const tree = [
    makeNode('data', {
      children: [makeNode('data.x'), makeNode('data.y', { children: [makeNode('data.y.z')] })],
    }),
  ];

  it('finds root-level nodes', () => {
    expect(findNode(tree, 'data')?.path).toBe('data');
  });

  it('finds nested nodes', () => {
    expect(findNode(tree, 'data.y.z')?.path).toBe('data.y.z');
  });

  it('returns undefined when path does not exist', () => {
    expect(findNode(tree, 'missing.path')).toBeUndefined();
  });
});

describe('updateNodeImmut', () => {
  it('updates matching node and preserves unrelated references', () => {
    const first = makeNode('a');
    const second = makeNode('b');
    const result = updateNodeImmut([first, second], 'a', (n) => ({ ...n, preview: 'updated' }));
    expect(result[0].preview).toBe('updated');
    expect(result[1]).toBe(second);
  });

  it('updates nested matching node', () => {
    const parent = makeNode('a', {
      children: [makeNode('a.child')],
    });
    const result = updateNodeImmut([parent], 'a.child', (n) => ({ ...n, preview: 'x' }));
    expect(result[0].children?.[0].preview).toBe('x');
  });
});
