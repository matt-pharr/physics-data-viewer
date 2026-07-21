/**
 * tree-utils.ts — pure helpers for flattened tree rendering.
 *
 * The Tree no longer owns a recursive node graph: listings live in the React
 * Query cache as one flat children array per parent path, and expansion is a
 * `Set<string>` of paths. Rendering composes those into depth-annotated rows
 * here. No React/runtime side effects; shared with unit tests.
 */

import type { TreeNodeData } from '../../types';

/** A renderable row: a node descriptor annotated with its indent depth. */
export type TreeRow = TreeNodeData & { depth: number };

/** The always-present, right-clickable root row wrapping the whole tree. */
export function syntheticRootRow(): TreeRow {
  return {
    id: '__root__',
    key: 'pdv_tree',
    path: '',
    type: 'root',
    preview: '',
    hasChildren: true,
    parentPath: null,
    isExpanded: true,
    isLoading: false,
    depth: 0,
  };
}

/**
 * Compose the visible row list from cached listings and the expansion set.
 *
 * A node renders as expanded when its path is in `expandedPaths` and it can
 * have children; its children render beneath it once their listing is in
 * `childrenByPath` (until then the node shows as expanded-but-empty, with a
 * spinner if the fetch has been pending long enough to enter
 * `loadingPaths`).
 *
 * @param childrenByPath - Cached children listing per parent path ('' = root).
 * @param expandedPaths - Paths the user has expanded.
 * @param loadingPaths - Paths whose pending fetch should show a spinner.
 * @returns Rows in render order, starting with the synthetic root.
 */
export function flattenFromCache(
  childrenByPath: ReadonlyMap<string, TreeNodeData[]>,
  expandedPaths: ReadonlySet<string>,
  loadingPaths: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [syntheticRootRow()];

  const visit = (nodes: TreeNodeData[], depth: number): void => {
    for (const node of nodes) {
      const isExpanded = Boolean(node.hasChildren) && expandedPaths.has(node.path);
      rows.push({
        ...node,
        depth,
        isExpanded,
        isLoading: loadingPaths.has(node.path),
      });
      if (isExpanded) {
        const children = childrenByPath.get(node.path);
        if (children) visit(children, depth + 1);
      }
    }
  };

  visit(childrenByPath.get('') ?? [], 1);
  return rows;
}

/**
 * Remove a path and all of its descendants from an expansion set.
 *
 * @param expanded - Current expansion set (not mutated).
 * @param path - Path being collapsed or removed.
 * @returns A new set without `path` or anything under it.
 */
export function collapseSubtree(
  expanded: ReadonlySet<string>,
  path: string,
): Set<string> {
  const prefix = path ? `${path}.` : '';
  const next = new Set<string>();
  for (const p of expanded) {
    if (p === path) continue;
    if (prefix && p.startsWith(prefix)) continue;
    next.add(p);
  }
  return next;
}
