import { describe, expect, it } from 'vitest';
import type { TreeNodeData } from '../../types';
import { collapseSubtree, flattenFromCache } from './tree-utils';

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
    type: 'folder',
    hasChildren: false,
    parentPath: parent,
    ...overrides,
  };
}

const NONE = new Set<string>();

describe('flattenFromCache', () => {
  it('always includes the synthetic root row', () => {
    const rows = flattenFromCache(new Map(), NONE, NONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('');
    expect(rows[0].key).toBe('pdv_tree');
    expect(rows[0].depth).toBe(0);
    expect(rows[0].isExpanded).toBe(true);
  });

  it('renders root children at depth 1', () => {
    const cache = new Map([['', [makeNode('a'), makeNode('b')]]]);
    const rows = flattenFromCache(cache, NONE, NONE);
    expect(rows.map((n) => n.path)).toEqual(['', 'a', 'b']);
    expect(rows[1].depth).toBe(1);
    expect(rows[2].depth).toBe(1);
  });

  it('includes children of expanded paths and omits collapsed ones', () => {
    const cache = new Map([
      ['', [makeNode('a', { hasChildren: true }), makeNode('b', { hasChildren: true })]],
      ['a', [makeNode('a.x')]],
      ['b', [makeNode('b.y')]],
    ]);
    const rows = flattenFromCache(cache, new Set(['a']), NONE);
    expect(rows.map((n) => n.path)).toEqual(['', 'a', 'a.x', 'b']);
    expect(rows.find((n) => n.path === 'a')?.isExpanded).toBe(true);
    expect(rows.find((n) => n.path === 'b')?.isExpanded).toBe(false);
    expect(rows.find((n) => n.path === 'a.x')?.depth).toBe(2);
  });

  it('treats an expanded path without cached children as expanded-but-empty', () => {
    const cache = new Map([['', [makeNode('a', { hasChildren: true })]]]);
    const rows = flattenFromCache(cache, new Set(['a']), NONE);
    expect(rows.map((n) => n.path)).toEqual(['', 'a']);
    expect(rows.find((n) => n.path === 'a')?.isExpanded).toBe(true);
  });

  it('never expands nodes without hasChildren, even if in the expansion set', () => {
    const cache = new Map([
      ['', [makeNode('a', { hasChildren: false })]],
      ['a', [makeNode('a.ghost')]],
    ]);
    const rows = flattenFromCache(cache, new Set(['a']), NONE);
    expect(rows.map((n) => n.path)).toEqual(['', 'a']);
    expect(rows.find((n) => n.path === 'a')?.isExpanded).toBe(false);
  });

  it('marks loading paths', () => {
    const cache = new Map([['', [makeNode('a', { hasChildren: true })]]]);
    const rows = flattenFromCache(cache, new Set(['a']), new Set(['a']));
    expect(rows.find((n) => n.path === 'a')?.isLoading).toBe(true);
  });

  it('handles deep nesting with correct depths', () => {
    const cache = new Map([
      ['', [makeNode('r', { hasChildren: true })]],
      ['r', [makeNode('r.c', { hasChildren: true })]],
      ['r.c', [makeNode('r.c.leaf')]],
    ]);
    const rows = flattenFromCache(cache, new Set(['r', 'r.c']), NONE);
    expect(rows.map((n) => [n.path, n.depth])).toEqual([
      ['', 0],
      ['r', 1],
      ['r.c', 2],
      ['r.c.leaf', 3],
    ]);
  });
});

describe('collapseSubtree', () => {
  it('removes the path itself', () => {
    expect(collapseSubtree(new Set(['a', 'b']), 'a')).toEqual(new Set(['b']));
  });

  it('removes all descendants but not similarly-prefixed siblings', () => {
    const expanded = new Set(['a', 'a.x', 'a.x.y', 'ab', 'ab.z', 'b']);
    expect(collapseSubtree(expanded, 'a')).toEqual(new Set(['ab', 'ab.z', 'b']));
  });

  it('leaves unrelated paths untouched and does not mutate the input', () => {
    const expanded = new Set(['a', 'b.c']);
    const result = collapseSubtree(expanded, 'b.c');
    expect(result).toEqual(new Set(['a']));
    expect(expanded.has('b.c')).toBe(true);
  });
});
