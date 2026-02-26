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
      return { ...node, children: updateNodeImmut(node.children, path, updater) };
    }
    return node;
  });
}
