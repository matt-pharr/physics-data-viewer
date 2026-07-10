/**
 * tree-utils.ts — pure tree helpers for flattened rendering and immutable updates.
 *
 * These utilities contain no React/runtime side effects and are shared between
 * Tree UI logic and unit tests.
 */

import type { TreeNodeData } from '../../types';

/** Flatten an expanded tree into depth-annotated rows for table rendering. */
export function flattenTree(
  nodes: TreeNodeData[],
  depth = 0,
): Array<TreeNodeData & { depth: number }> {
  const result: Array<TreeNodeData & { depth: number }> = [];

  for (const node of nodes) {
    result.push({ ...node, depth });
    if (node.isExpanded && node.children) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }

  return result;
}

/** Find a node by dot-path in a tree collection. */
export function findNode(nodes: TreeNodeData[], path: string): TreeNodeData | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/** Immutably remove a node by path from a tree collection. */
export function removeNodeImmut(
  list: TreeNodeData[],
  path: string,
): TreeNodeData[] {
  let changed = false;
  const result: TreeNodeData[] = [];

  for (const node of list) {
    if (node.path === path) {
      changed = true;
      continue; // skip this node (remove it)
    }
    if (node.children) {
      const updatedChildren = removeNodeImmut(node.children, path);
      if (updatedChildren !== node.children) {
        result.push({ ...node, children: updatedChildren });
        changed = true;
        continue;
      }
    }
    result.push(node);
  }

  return changed ? result : list;
}

/**
 * Compare two child lists for visible structural difference.
 *
 * Returns true if a 1 Hz safety-net poll has detected drift the renderer
 * should re-render — i.e. a child was added, removed, or its visible
 * descriptor (key, type, hasChildren, preview) changed.
 *
 * Used to suppress no-op refreshes from idle polls. Push-driven updates
 * ride a separate code path and don't go through this comparison.
 */
export function childrenDiffer(a: TreeNodeData[], b: TreeNodeData[]): boolean {
  if (a.length !== b.length) return true;
  const byPath = new Map<string, TreeNodeData>();
  for (const node of a) byPath.set(node.path, node);
  for (const node of b) {
    const existing = byPath.get(node.path);
    if (!existing) return true;
    if (existing.key !== node.key) return true;
    if (existing.type !== node.type) return true;
    if (existing.hasChildren !== node.hasChildren) return true;
    if (existing.preview !== node.preview) return true;
  }
  return false;
}

/**
 * Merge freshly fetched children with the existing child list, preserving
 * per-node UI state the fetch cannot know about (expansion and already-loaded
 * grandchildren). Fresh nodes win on descriptor fields; nodes that no longer
 * exist are dropped; new nodes appear collapsed.
 */
export function mergeChildren(
  fresh: TreeNodeData[],
  existing: TreeNodeData[] | undefined,
): TreeNodeData[] {
  if (!existing || existing.length === 0) return fresh;
  const byPath = new Map<string, TreeNodeData>();
  for (const node of existing) byPath.set(node.path, node);
  return fresh.map((node) => {
    const old = byPath.get(node.path);
    if (old?.isExpanded && old.children) {
      return { ...node, isExpanded: true, children: old.children };
    }
    return node;
  });
}

/** Immutably update one node by path while preserving unrelated references. */
export function updateNodeImmut(
  list: TreeNodeData[],
  path: string,
  updater: (n: TreeNodeData) => TreeNodeData,
): TreeNodeData[] {
  return list.map((node) => {
    if (node.path === path) {
      return updater(node);
    }
    if (node.children) {
      const updatedChildren = updateNodeImmut(node.children, path, updater);
      if (updatedChildren !== node.children) {
        return { ...node, children: updatedChildren };
      }
    }
    return node;
  });
}
