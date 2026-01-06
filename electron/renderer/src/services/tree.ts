import type { TreeNode } from '../../../main/ipc';
import type { TreeNodeData } from '../types';

class TreeService {
  private cache: Map<string, TreeNodeData[]> = new Map();

  private cacheKey(kernelId: string | null, path: string) {
    const safeKernel = kernelId ?? '__none__';
    return `${safeKernel}|${path}`;
  }

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

  async createScript(kernelId: string, targetPath: string, scriptName: string): Promise<TreeNodeData | undefined> {
    const result = await window.pdv.tree.createScript(kernelId, targetPath, scriptName);
    if (!result.success) {
      throw new Error(result.error || 'Failed to create script');
    }
    this.clearCache(kernelId);
    return result.node ? this.enrichNode(result.node) : undefined;
  }

  clearCache(kernelId?: string | null): void {
    if (!kernelId) {
      this.cache.clear();
      return;
    }
    const prefix = `${kernelId}:`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private enrichNode = (node: TreeNode): TreeNodeData => ({
    ...node,
    isExpanded: false,
    isLoading: false,
  });
}

export const treeService = new TreeService();
export type { TreeNodeData };
