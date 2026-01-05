import type { TreeNode } from '../../../main/ipc';
import type { TreeNodeData } from '../types';

class TreeService {
  private cache: Map<string, TreeNodeData[]> = new Map();

  async getRootNodes(): Promise<TreeNodeData[]> {
    const cached = this.cache.get('');
    if (cached) {
      return cached;
    }

    const nodes = await window.pdv.tree.list('');
    const enriched = nodes.map(this.enrichNode);
    this.cache.set('', enriched);
    return enriched;
  }

  async getChildren(node: TreeNodeData): Promise<TreeNodeData[]> {
    if (!node.hasChildren) {
      return [];
    }

    const cached = this.cache.get(node.path);
    if (cached) {
      return cached;
    }

    const nodes = await window.pdv.tree.list(node.path);
    const enriched = nodes.map(this.enrichNode);
    this.cache.set(node.path, enriched);
    return enriched;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private enrichNode(node: TreeNode): TreeNodeData {
    return {
      ...node,
      isExpanded: false,
      isLoading: false,
    };
  }
}

export const treeService = new TreeService();
export type { TreeNodeData };
