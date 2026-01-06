/**
 * File System Scanner
 *
 * Scans the project's tree/ directory and builds TreeNode structure.
 * Detects file types and extracts metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TreeNode } from './ipc';

export interface ScanOptions {
  projectRoot: string;
  includeHidden?: boolean;
}

export class FileScanner {
  private projectRoot: string;
  private treeRoot: string;
  private includeHidden: boolean;

  constructor(projectRoot: string, options?: { includeHidden?: boolean }) {
    this.projectRoot = projectRoot;
    this.treeRoot = path.join(projectRoot, 'tree');
    this.includeHidden = options?.includeHidden ?? false;
  }

  /**
   * Scan entire tree directory
   */
  async scanAll(): Promise<TreeNode[]> {
    if (!fs.existsSync(this.treeRoot)) {
      fs.mkdirSync(this.treeRoot, { recursive: true });
      fs.mkdirSync(path.join(this.treeRoot, 'data'), { recursive: true });
      fs.mkdirSync(path.join(this.treeRoot, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(this.treeRoot, 'results'), { recursive: true });
    }

    return this.scanDirectory(this.treeRoot, '');
  }

  /**
   * Scan a specific directory
   */
  async scanDirectory(dirPath: string, relativePath: string): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!this.includeHidden && entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        const baseName = entry.isFile() ? path.parse(entry.name).name : entry.name;
        const nodePath = relativePath ? `${relativePath}.${baseName}` : baseName;
        const stats = fs.statSync(fullPath);

        if (entry.isDirectory()) {
          nodes.push({
            id: nodePath,
            key: entry.name,
            path: nodePath,
            type: 'folder',
            hasChildren: true,
            expandable: true,
            _file_path: fullPath,
          });
        } else if (entry.isFile()) {
          const node = await this.createFileNode(fullPath, entry.name, nodePath, stats);
          nodes.push(node);
        }
      }
    } catch (error) {
      console.error(`[FileScanner] Failed to scan ${dirPath}:`, error);
    }

    return nodes;
  }

  /**
   * Create TreeNode for a file
   */
  private async createFileNode(
    filePath: string,
    fileName: string,
    nodePath: string,
    stats: fs.Stats,
  ): Promise<TreeNode> {
    const ext = path.extname(fileName).toLowerCase();
    const node: TreeNode = {
      id: nodePath,
      key: fileName,
      path: nodePath,
      type: this.detectFileType(ext),
      hasChildren: false,
      sizeBytes: stats.size,
      _file_path: filePath,
      _modified: stats.mtime.toISOString(),
    };

    if (ext === '.py' || ext === '.jl') {
      node.type = 'script';
      node.language = ext === '.py' ? 'python' : 'julia';
      node.actions = ['run', 'edit', 'reload', 'view_source'];

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const docstring = this.extractDocstring(content, ext);
        if (docstring) {
          node.preview = docstring;
        }
      } catch (error) {
        console.warn(`[FileScanner] Failed to read ${filePath}:`, error);
      }
    } else if (ext === '.h5' || ext === '.hdf5') {
      node.type = 'hdf5';
      node.loaderHint = 'hdf5';
      node.hasChildren = true;
      node.actions = ['load', 'inspect'];
    } else if (ext === '.zarr') {
      node.type = 'zarr';
      node.loaderHint = 'zarr';
      node.hasChildren = true;
      node.actions = ['load', 'inspect'];
    } else if (ext === '.parquet') {
      node.type = 'parquet';
      node.loaderHint = 'parquet';
      node.actions = ['load', 'preview'];
    } else if (ext === '.npy' || ext === '.npz') {
      node.type = 'npy';
      node.loaderHint = 'npy';
      node.actions = ['load'];
    } else if (['.png', '.jpg', '.jpeg', '.svg'].includes(ext)) {
      node.type = 'image';
      node.loaderHint = 'image';
      node.actions = ['view', 'open'];
    } else if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) {
      node.type = 'config';
      node.actions = ['view', 'edit'];
    } else {
      node.type = node.type || 'file';
      node.actions = ['view', 'open'];
    }

    return node;
  }

  /**
   * Detect file type from extension
   */
  private detectFileType(ext: string): TreeNode['type'] {
    const typeMap: Record<string, TreeNode['type']> = {
      '.py': 'script',
      '.jl': 'script',
      '.h5': 'hdf5',
      '.hdf5': 'hdf5',
      '.zarr': 'zarr',
      '.parquet': 'parquet',
      '.arrow': 'arrow',
      '.npy': 'npy',
      '.npz': 'npy',
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.svg': 'image',
      '.json': 'config',
      '.yaml': 'config',
      '.yml': 'config',
      '.toml': 'config',
      '.txt': 'text',
      '.md': 'text',
    };

    return typeMap[ext] || 'file';
  }

  /**
   * Extract docstring from script file
   */
  private extractDocstring(content: string, ext: string): string | undefined {
    if (ext === '.py') {
      const moduleDocMatch =
        content.match(/^"""([\s\S]*?)"""/m) || content.match(/^'''([\s\S]*?)'''/m);
      if (moduleDocMatch) {
        return moduleDocMatch[1].trim().split('\n')[0];
      }

      const runDocMatch =
        content.match(/def\s+run\([^)]*\):[\s\S]*?"""([\s\S]*?)"""/) ||
        content.match(/def\s+run\([^)]*\):[\s\S]*?'''([\s\S]*?)'''/);
      if (runDocMatch) {
        return runDocMatch[1].trim().split('\n')[0];
      }
    } else if (ext === '.jl') {
      const moduleDocMatch = content.match(/^"""([\s\S]*?)"""/m);
      if (moduleDocMatch) {
        return moduleDocMatch[1].trim().split('\n')[0];
      }

      const runDocMatch = content.match(/"""([\s\S]*?)"""\s*function run\(/);
      if (runDocMatch) {
        return runDocMatch[1].trim().split('\n')[0];
      }
    }

    return undefined;
  }

  /**
   * Get children of a directory node
   */
  async getChildren(nodePath: string): Promise<TreeNode[]> {
    const relativePathParts = nodePath.split('.');
    const dirPath = path.join(this.treeRoot, ...relativePathParts);

    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return [];
    }

    return this.scanDirectory(dirPath, nodePath);
  }
}
