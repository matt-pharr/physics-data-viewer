/**
 * tree.ts — Renderer-side tree data access service.
 *
 * Wraps `window.pdv.tree.*` calls with a small in-memory cache keyed by
 * kernel-id + node path so tree expansion remains responsive.
 */

import type { NodeDescriptor } from '../types/pdv';
import type { TreeNodeData } from '../types';

/** Tree API adapter with per-kernel/path caching. */
class TreeService {
  private cache: Map<string, TreeNodeData[]> = new Map();

  /** Build a stable cache key scoped to kernel and tree path. */
  private cacheKey(kernelId: string | null, path: string) {
    const safeKernel = kernelId ?? '__none__';
    return `${safeKernel}|${path}`;
  }

  /** Fetch and cache root-level tree nodes for the active kernel. */
  async getRootNodes(kernelId: string | null): Promise<TreeNodeData[]> {
    if (!kernelId) return [];

    const key = this.cacheKey(kernelId, '');
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const nodes = await window.pdv.tree.list(kernelId, '');
    const enriched = nodes.map(this.enrichNode);
    this.cache.set(key, enriched);
    return enriched;
  }

  /** Fetch and cache children for one expanded parent node. */
  async getChildren(node: TreeNodeData, kernelId: string | null): Promise<TreeNodeData[]> {
    if (!kernelId) return [];
    if (!node.hasChildren) {
      return [];
    }

    const key = this.cacheKey(kernelId, node.path);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const nodes = await window.pdv.tree.list(kernelId, node.path);
    const enriched = nodes.map(this.enrichNode);
    this.cache.set(key, enriched);
    return enriched;
  }

  /** Create a script node and invalidate relevant cached tree snapshots. */
  async createScript(kernelId: string, targetPath: string, scriptName: string): Promise<TreeNodeData | undefined> {
    const result = await window.pdv.tree.createScript(kernelId, targetPath, scriptName);
    if (!result.success) {
      throw new Error(result.error || 'Failed to create script');
    }
    this.clearCache(kernelId);
    return undefined;
  }

  /** Clear all cache entries, or only entries for a specific kernel id. */
  clearCache(kernelId?: string | null): void {
    if (!kernelId) {
      this.cache.clear();
      return;
    }
    const safeKernel = kernelId ?? '__none__';
    const prefix = `${safeKernel}|`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Convert backend node descriptor fields to renderer-friendly shape. */
  private enrichNode = (node: NodeDescriptor): TreeNodeData => ({
    ...node,
    hasChildren: Boolean(node.has_children),
    parentPath: node.parent_path ?? null,
    params: node.params,
    isExpanded: false,
    isLoading: false,
  });
}

/** Singleton tree service used by tree-related renderer components. */
export const treeService = new TreeService();
/** Re-export local tree node shape for component imports. */
export type { TreeNodeData };
