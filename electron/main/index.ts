/**
 * IPC Handler Registration
 *
 * Registers all IPC handlers for communication with the renderer.
 * Kernel operations are delegated to the KernelManager class.
 */

import { ipcMain, app, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  IPC,
  KernelInfo,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
  TreeNode,
  FileReadResult,
  Config,
  NamespaceQueryOptions,
  NamespaceVariable,
  ScriptRunRequest,
  ScriptRunResult,
  ScriptParameter,
  CommandBoxData,
  Theme,
} from './ipc';
import { getKernelManager, resetKernelManager } from './kernel-manager';
import { loadConfig, loadThemes, saveTheme, updateConfig } from './config';
import { spawn } from 'child_process';
import * as os from 'os';
import { FileScanner } from './file-scanner';

const SCRIPT_STUB = `"""New PDV script"""
def run(tree: dict, **kwargs):
    # add your code here
    return {}
`;

// ============================================================================
// Kernel Manager Instance
// ============================================================================

const kernelManager = getKernelManager();
let currentConfig: Config = loadConfig();
let fileScanner: FileScanner | null = null;

/**
 * Get the tree root directory from config with fallback chain.
 * Priority: config.treeRoot > config.projectRoot/tree > config.cwd/tree > process.cwd()/tree
 * 
 * @returns The tree root directory path
 */
function getTreeRoot(): string {
  const config = loadConfig();
  if (config.treeRoot) {
    return config.treeRoot;
  }
  const projectRoot = config.projectRoot || config.cwd || process.cwd();
  return path.join(projectRoot, 'tree');
}

function getFileScanner(): FileScanner {
  if (!fileScanner) {
    const treeRoot = getTreeRoot();
    fileScanner = new FileScanner(treeRoot);
  }
  return fileScanner;
}

const canRegisterHandlers = !!ipcMain && typeof ipcMain.handle === 'function';

if (!canRegisterHandlers) {
  console.warn('[main] ipcMain not available; skipping IPC handler registration');
} else {
  // Cleanup on app quit
  if (app?.on) {
    app.on('before-quit', async () => {
      console.log('[main] App quitting, shutting down kernels...');
      await kernelManager.shutdownAll();
      resetKernelManager();
    });
  }

  // ============================================================================
  // Kernel Handlers
  // ============================================================================

  ipcMain.handle(IPC.kernels.list, async (): Promise<KernelInfo[]> => {
    return kernelManager.list();
  });

  ipcMain.handle(IPC.kernels.start, async (_event, spec): Promise<KernelInfo> => {
    return kernelManager.start(spec);
  });

  ipcMain.handle(IPC.kernels.stop, async (_event, id): Promise<boolean> => {
    return kernelManager.stop(id);
  });

  ipcMain.handle(IPC.kernels.execute, async (_event, id, request): Promise<KernelExecuteResult> => {
    return kernelManager.execute(id, request);
  });

  ipcMain.handle(IPC.kernels.interrupt, async (_event, id): Promise<boolean> => {
    return kernelManager.interrupt(id);
  });

  ipcMain.handle(IPC.kernels.restart, async (_event, id): Promise<KernelInfo> => {
    return kernelManager.restart(id);
  });

  ipcMain.handle(IPC.kernels.complete, async (_event, id, code, cursorPos): Promise<KernelCompleteResult> => {
    return kernelManager.complete(id, code, cursorPos);
  });

  ipcMain.handle(IPC.kernels.inspect, async (_event, id, code, cursorPos): Promise<KernelInspectResult> => {
    return kernelManager.inspect(id, code, cursorPos);
  });

  ipcMain.handle(IPC.kernels.validate, async (_event, execPath: string, language: 'python' | 'julia') => {
    try {
      const sanitizedPath = typeof execPath === 'string' ? execPath.trim() : '';
      if (!sanitizedPath || sanitizedPath.includes('\n')) {
        return { valid: false, error: 'Invalid executable path' };
      }
      const unsafePathPattern = /[^A-Za-z0-9_\s/.:+\-\\()]/;
      if (unsafePathPattern.test(sanitizedPath) || sanitizedPath.length > 512) {
        return { valid: false, error: 'Executable path contains invalid characters' };
      }

      if (path.isAbsolute(sanitizedPath)) {
        try {
          await fs.promises.access(sanitizedPath, fs.constants.X_OK);
        } catch {
          return { valid: false, error: `Executable not found or not accessible: ${sanitizedPath}` };
        }
      }

      const args =
        language === 'python'
          ? [sanitizedPath, '-m', 'ipykernel', '--version']
          : [sanitizedPath, '-e', 'using IJulia;'];

      return await new Promise<{ valid: boolean; error?: string }>((resolve) => {
        const proc = spawn(args[0], args.slice(1));
        let output = '';
        const MAX_OUTPUT = 4096;
        let resolved = false;
        const killTimer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            proc.kill();
            resolve({ valid: false, error: 'Validation timed out' });
          }
        }, 10000);

        const appendOutput = (data: Buffer) => {
          if (output.length >= MAX_OUTPUT) {
            return;
          }
          output += data.toString();
          if (output.length > MAX_OUTPUT) {
            output = output.slice(0, MAX_OUTPUT);
          }
        };

        proc.stdout.on('data', (data) => appendOutput(data));
        proc.stderr.on('data', (data) => appendOutput(data));

        proc.on('close', (code) => {
          if (resolved) {
            clearTimeout(killTimer);
            return;
          }
          resolved = true;
          clearTimeout(killTimer);
          if (code === 0) {
            resolve({ valid: true });
          } else {
            resolve({
              valid: false,
              error: `${language === 'python' ? 'ipykernel' : 'IJulia'} not found. Output: ${output}`.trim(),
            });
          }
        });

        proc.on('error', (err) => {
          if (resolved) {
            clearTimeout(killTimer);
            return;
          }
          resolved = true;
          clearTimeout(killTimer);
          resolve({
            valid: false,
            error: `Failed to run ${sanitizedPath}: ${err.message}`,
          });
        });
      });
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ============================================================================
  // Namespace Handlers
  // ============================================================================

  ipcMain.handle(
    IPC.namespace.query,
    async (_event, kernelId: string, options?: NamespaceQueryOptions): Promise<{ variables?: NamespaceVariable[]; error?: string }> => {
      console.log('[IPC] namespace:query', kernelId, options);

      if (!kernelId) {
        return { error: 'No kernel ID provided' };
      }

      try {
        const kernel = kernelManager.getKernel(kernelId);

        if (!kernel) {
          return { error: `Kernel not found: ${kernelId}` };
        }

        const language = kernel.language;
        let code = '';

        if (language === 'python') {
          const includePrivate = options?.includePrivate ? 'True' : 'False';
          const includeModules = options?.includeModules ? 'True' : 'False';
          const includeCallables = options?.includeCallables ? 'True' : 'False';
          // Ask IPython to emit application/json so we avoid repr strings with single quotes
          code = `from IPython.display import JSON as PDVJSON\nPDVJSON(pdv_namespace(include_private=${includePrivate}, include_modules=${includeModules}, include_callables=${includeCallables}))`;
        } else if (language === 'julia') {
          const includePrivate = options?.includePrivate ? 'true' : 'false';
          const includeModules = options?.includeModules ? 'true' : 'false';
          code = `using JSON; JSON.json(pdv_namespace(include_private=${includePrivate}, include_modules=${includeModules}))`;
        } else {
          return { error: `Unsupported language: ${language}` };
        }

        const result = await kernelManager.execute(kernelId, { code });

        if (result.error) {
          return { error: result.error };
        }

        try {
          let namespaceData: unknown = result.result;

          // Prefer structured JSON results from the kernel when available
          if (typeof namespaceData === 'string') {
            let serialized = namespaceData.trim();
            if (
              (serialized.startsWith("'") && serialized.endsWith("'")) ||
              (serialized.startsWith('"') && serialized.endsWith('"'))
            ) {
              serialized = serialized.slice(1, -1);
            }

            const tryParse = (value: string) => {
              const cleaned = value.replace(/\\'/g, "'");
              return JSON.parse(cleaned);
            };

            namespaceData = tryParse(serialized);

            // Fallback: some kernels may double-escape JSON; try an extra unwrap
            if (typeof namespaceData === 'string') {
              namespaceData = tryParse(namespaceData);
            }
          }

          if (!namespaceData || typeof namespaceData !== 'object') {
            return { error: 'Namespace result could not be parsed into an object' };
          }
          const variables: NamespaceVariable[] = Object.entries(namespaceData).map(
            ([name, info]) =>
              ({
                name,
                ...(info as Omit<NamespaceVariable, 'name'>),
              }) as NamespaceVariable,
          );

          return { variables };
        } catch (parseError) {
          return { error: `Failed to parse namespace: ${parseError instanceof Error ? parseError.message : String(parseError)}` };
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // ============================================================================
  // Tree Handlers (unchanged from Step 2)
  // ============================================================================

  ipcMain.handle(IPC.tree.list, async (_event, kernelId: string, path): Promise<TreeNode[]> => {
    console.log('[IPC] tree:list', kernelId, path);

    return listTreeFromKernel(kernelId, path);
  });

  ipcMain.handle(IPC.tree.get, async (_event, id, options): Promise<unknown> => {
    console.log('[IPC] tree:get', id, options);
    return null;
  });

  ipcMain.handle(IPC.tree.save, async (_event, id, value): Promise<boolean> => {
    console.log('[IPC] tree:save', id, value);
    return true;
  });

  ipcMain.handle(
    IPC.tree.create_script,
    async (_event, kernelId: string, targetPath: string, scriptName: string) => {
      console.log('[IPC] tree:create_script', kernelId, targetPath, scriptName);

      try {
        const sanitized = sanitizeScriptName(scriptName);
        if (!sanitized) {
          return { success: false, error: 'Invalid script name' };
        }

        const config = loadConfig();
        const treeRoot = config.treeRoot || path.join(config.projectRoot || config.cwd || process.cwd(), 'tree');
        const folderParts = targetPath ? targetPath.split('.').filter(Boolean) : [];
        const folderPath = path.join(treeRoot, ...folderParts);
        await fs.promises.mkdir(folderPath, { recursive: true });

        const fileName = sanitized.endsWith('.py') ? sanitized : `${sanitized}.py`;
        const baseName = fileName.replace(/\.py$/i, '');
        const filePath = path.join(folderPath, fileName);

        if (fs.existsSync(filePath)) {
          return { success: false, error: `File already exists: ${fileName}` };
        }

        const now = new Date();
        const header = [
          '"""',
          `${fileName}`,
          `created by ${os.userInfo().username} on ${os.hostname()} at ${String(now.getHours()).padStart(2, '0')}:${String(
            now.getMinutes(),
          ).padStart(2, '0')}`,
          'Description: ',
          '',
          '"""',
          '',
        ].join('\n');
        const stub = `${header}${SCRIPT_STUB}`;
        await fs.promises.writeFile(filePath, stub, 'utf-8');

        // Register script inside kernel tree (best-effort)
        const registerResult = await registerScriptInKernel(kernelId, targetPath, baseName, filePath);
        if (registerResult?.error) {
          console.warn('[IPC] Failed to register script in kernel:', registerResult.error);
        }

        // Open in configured editor (best-effort)
        const language = 'python';
        void openInEditor(filePath, language);

        // Try to fetch newly created node for immediate UI update
        const parentNodes = await listTreeFromKernel(kernelId, targetPath);
        const fullPath = targetPath ? `${targetPath}.${baseName}` : baseName;
        const node = parentNodes.find((n) => n.path === fullPath);

        return { success: true, node };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // ============================================================================
  // Script Handlers
  // ============================================================================

  ipcMain.handle(IPC.script.run, async (_event, kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult> => {
    console.log('[IPC] script:run', kernelId, request);

    try {
      const kernel = kernelManager.getKernel(kernelId);
      if (!kernel) {
        return { success: false, error: `Kernel not found: ${kernelId}` };
      }

      const scanner = getFileScanner();
      const scriptNode = await resolveNodeByPath(scanner, request.scriptPath);

      if (!scriptNode || !scriptNode._file_path) {
        return { success: false, error: `Script not found: ${request.scriptPath}` };
      }

      const language = kernel.language;
      let code = '';

      if (language === 'python') {
        const paramsJson = JSON.stringify(request.params || {});
        const encoded = Buffer.from(paramsJson, 'utf-8').toString('base64');
        code = [
          'import json, base64',
          `_params = json.loads(base64.b64decode("${encoded}").decode("utf-8"))`,
          `tree.run_script("${request.scriptPath}", **_params)`,
        ].join('\n');
      } else if (language === 'julia') {
        const paramsJson = JSON.stringify(request.params || {});
        const encoded = Buffer.from(paramsJson, 'utf-8').toString('base64');
        code = [
          'using JSON, Base64',
          `_params = JSON.parse(String(base64decode("${encoded}")))`,
          'kwargs = (; (Symbol(k) => v for (k, v) in _params)...)',
          `tree.run_script("${request.scriptPath}"; kwargs...)`,
        ].join('\n');
      } else {
        return { success: false, error: `Unsupported language: ${language}` };
      }

      const startTime = Date.now();
      const result = await kernelManager.execute(kernelId, { code });

      if (result.error) {
        return {
          success: false,
          error: result.error,
          stdout: result.stdout,
          stderr: result.stderr,
          duration: Date.now() - startTime,
        };
      }

      return {
        success: true,
        result: result.result,
        stdout: result.stdout,
        stderr: result.stderr,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(IPC.script.edit, async (_event, scriptPath: string) => {
    console.log('[IPC] script:edit', scriptPath);

    try {
      const scanner = getFileScanner();
      const scriptNode = await resolveNodeByPath(scanner, scriptPath);

      if (!scriptNode || !scriptNode._file_path) {
        return { success: false, error: `Script not found: ${scriptPath}` };
      }

      const filePath = scriptNode._file_path;
      const language = scriptNode.language || 'python';

      const editorResult = openInEditor(filePath, language);
      if (!editorResult.success && editorResult.error) {
        return { success: false, error: editorResult.error };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(IPC.script.reload, async (_event, scriptPath: string) => {
    console.log('[IPC] script:reload', scriptPath);
    return { success: true };
  });

  ipcMain.handle(IPC.script.get_params, async (_event, scriptPath: string) => {
    console.log('[IPC] script:get_params', scriptPath);

    try {
      const scanner = getFileScanner();
      const scriptNode = await resolveNodeByPath(scanner, scriptPath);

      if (!scriptNode || !scriptNode._file_path) {
        return { success: false, error: `Script not found: ${scriptPath}` };
      }

      const content = await fs.promises.readFile(scriptNode._file_path, 'utf-8');
      const language = scriptNode.language;

      const params: ScriptParameter[] = [];

      if (language === 'python') {
        const match = content.match(/def\s+run\(([\s\S]*?)\)/);
        if (match) {
          const argsStr = match[1];
          const args = argsStr.split(',').map((a) => a.trim()).filter(Boolean);

          for (const arg of args) {
            if (arg === 'tree' || arg === 'self') continue;

            const [nameType, ...defaultParts] = arg.split('=');
            const [namePart, typePart] = nameType.split(':');
            const name = namePart.trim();
            const typeHint = typePart ? typePart.trim() : undefined;
            const defaultValue = defaultParts.length > 0 ? defaultParts.join('=').trim() : undefined;

            if (name === 'tree') {
              continue;
            }

            params.push({
              name,
              type: typeHint || 'unknown',
              default: defaultValue !== undefined ? parseDefaultValue(defaultValue) : undefined,
              required: defaultValue === undefined,
            });
          }
        }
      } else if (language === 'julia') {
        const match = content.match(/function run\(([\s\S]*?)\)/);
        if (match) {
          const argsStr = match[1];
          const args = argsStr.split(',').map((a) => a.trim()).filter(Boolean);

          for (const arg of args) {
            if (arg === 'tree') continue;

            const [nameType, defaultValue] = arg.split('=').map((s) => s.trim());
            const [namePart, typePart] = nameType.split('::');
            const name = namePart.trim();
            const typeHint = typePart ? typePart.trim() : undefined;

            if (name === 'tree') {
              continue;
            }

            params.push({
              name,
              type: typeHint || 'Any',
              default: defaultValue !== undefined ? parseDefaultValue(defaultValue) : undefined,
              required: defaultValue === undefined,
            });
          }
        }
      }

      return { success: true, params };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ============================================================================
  // File Handlers (unchanged from Step 2)
  // ============================================================================

  ipcMain.handle(IPC.files.read, async (_event, filePath, options): Promise<FileReadResult | null> => {
    console.log('[IPC] files:read', filePath, options);
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        content,
        size: stats.size,
        mtime: stats.mtime.getTime(),
      };
    } catch (error) {
      console.error('[IPC] files:read error:', error);
      return null;
    }
  });

  ipcMain.handle(IPC.files.write, async (_event, filePath, content): Promise<boolean> => {
    console.log('[IPC] files:write', filePath, typeof content === 'string' ? content.slice(0, 100) : '<binary>');
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      if (typeof content === 'string') {
        fs.writeFileSync(filePath, content, 'utf-8');
      } else {
        fs.writeFileSync(filePath, Buffer.from(content));
      }
      return true;
    } catch (error) {
      console.error('[IPC] files:write error:', error);
      return false;
    }
  });

  ipcMain.handle(IPC.files.pickExecutable, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle(IPC.files.watch, async () => false);
  ipcMain.handle(IPC.files.unwatch, async () => false);

  // ============================================================================
  // Config Handlers (unchanged from Step 2)
  // ============================================================================

  ipcMain.handle(IPC.config.get, async (): Promise<Config> => {
    return currentConfig;
  });

  ipcMain.handle(IPC.config.set, async (_event, config): Promise<boolean> => {
    console.log('[IPC] config:set', config);
    currentConfig = updateConfig(config);
    fileScanner = null;
    return true;
  });

  ipcMain.handle(IPC.themes.get, async (): Promise<Theme[]> => {
    return loadThemes();
  });

  ipcMain.handle(IPC.themes.save, async (_event, theme: Theme): Promise<boolean> => {
    saveTheme(theme);
    return true;
  });

  // ============================================================================
  // Command Box Handlers
  // ============================================================================

  /**
   * Get the command boxes file path.
   * Command boxes are stored in the project directory (parent of tree root).
   * Example: If tree is at /tmp/user/PDV-2026_02_19_15:37:46/tree,
   * command boxes are at /tmp/user/PDV-2026_02_19_15:37:46/command-boxes.json
   * 
   * @returns The full path to command-boxes.json
   */
  function getCommandBoxesPath(): string {
    const treeRoot = getTreeRoot();
    const projectDir = path.dirname(treeRoot);
    return path.join(projectDir, 'command-boxes.json');
  }

  ipcMain.handle(IPC.commandBoxes.load, async (): Promise<CommandBoxData | null> => {
    console.log('[IPC] commandBoxes:load');
    try {
      const commandBoxesPath = getCommandBoxesPath();
      console.log('[IPC] commandBoxes:load path:', commandBoxesPath);
      
      if (!fs.existsSync(commandBoxesPath)) {
        console.log('[IPC] commandBoxes:load - file does not exist, returning null');
        return null;
      }
      
      const content = fs.readFileSync(commandBoxesPath, 'utf-8');
      const data = JSON.parse(content) as CommandBoxData;
      console.log('[IPC] commandBoxes:load - loaded', data.tabs.length, 'tabs');
      return data;
    } catch (error) {
      console.error('[IPC] commandBoxes:load error:', error);
      return null;
    }
  });

  ipcMain.handle(IPC.commandBoxes.save, async (_event, data: CommandBoxData): Promise<boolean> => {
    console.log('[IPC] commandBoxes:save', data.tabs.length, 'tabs');
    try {
      const commandBoxesPath = getCommandBoxesPath();
      console.log('[IPC] commandBoxes:save path:', commandBoxesPath);
      
      // Ensure directory exists
      const dir = path.dirname(commandBoxesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(commandBoxesPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log('[IPC] commandBoxes:save - success');
      return true;
    } catch (error) {
      console.error('[IPC] commandBoxes:save error:', error);
      return false;
    }
  });

  // ============================================================================

  console.log('[main] IPC handlers registered');
}

async function resolveNodeByPath(scanner: FileScanner, targetPath: string): Promise<TreeNode | undefined> {
  const parts = targetPath.split('.').filter(Boolean);
  let nodes = await scanner.scanAll();
  let currentNode: TreeNode | undefined;
  let currentPath = '';

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}.${part}` : part;
    currentNode = nodes.find((n) => n.path === currentPath);
    if (!currentNode) {
      return undefined;
    }
    if (currentPath !== targetPath && currentNode.hasChildren) {
      nodes = await scanner.getChildren(currentNode.path);
    }
  }

  return currentNode;
}

async function listTreeFromKernel(kernelId: string, path: string | undefined): Promise<TreeNode[]> {
  if (!kernelId) {
    return [];
  }

  const kernel = kernelManager.getKernel(kernelId);
  if (!kernel || kernel.language !== 'python') {
    return [];
  }

  const trySnapshot = async (code: string) => {
    const result = await kernelManager.execute(kernelId, { code });
    if (result.error) {
      console.warn('[tree] Kernel returned error:', result.error);
      return undefined;
    }
    return parseJsonResult(result.result);
  };

  try {
    const primary = await trySnapshot(buildTreeQueryCode(path || ''));
    const parsedPrimary = Array.isArray(primary) ? primary : undefined;

    const fallback =
      parsedPrimary ||
      (await trySnapshot(buildTreeQueryFallback(path || ''))) ||
      undefined;

    if (!Array.isArray(fallback)) {
      return [];
    }

    return fallback.map(normalizeTreeNode).filter(Boolean) as TreeNode[];
  } catch (error) {
    console.warn('[tree] Failed to list tree from kernel:', error);
    return [];
  }
}

function normalizeTreeNode(node: unknown): TreeNode | null {
  if (!node || typeof node !== 'object') return null;
  const base = node as Partial<TreeNode>;
  if (!base.path || !base.key || !base.id) return null;
  return {
    preview: base.preview,
    hasChildren: !!base.hasChildren,
    type: base.type || 'unknown',
    id: base.id,
    key: base.key,
    path: base.path,
    sizeBytes: base.sizeBytes,
    shape: base.shape,
    dtype: base.dtype,
    loaderHint: base.loaderHint,
    actions: base.actions,
    expandable: base.expandable,
    lazy: base.lazy,
    language: base.language,
    _file_path: base._file_path,
    _modified: base._modified,
  };
}

function buildTreeQueryCode(path: string): string {
  const safePath = JSON.stringify(path ?? '');
  return ['from IPython.display import JSON as PDVJSON', `PDVJSON(pdv_tree_snapshot(${safePath}))`].join('\n');
}

function buildTreeQueryFallback(path: string): string {
  const safePath = JSON.stringify(path ?? '');
  return ['import json', `print(json.dumps(pdv_tree_snapshot(${safePath})))`].join('\n');
}

/**
 * Normalize kernel results that may arrive as JSON objects or doubly-quoted strings.
 * Handles cases where kernels emit JSON strings wrapped in single/double quotes or
 * double-encoded JSON payloads, returning the parsed object when possible.
 */
function parseJsonResult(raw: unknown): any {
  let namespaceData: unknown = raw;
  if (typeof namespaceData === 'string') {
    let serialized = namespaceData.trim();
    if (
      (serialized.startsWith("'") && serialized.endsWith("'")) ||
      (serialized.startsWith('"') && serialized.endsWith('"'))
    ) {
      serialized = serialized.slice(1, -1);
    }

    const tryParse = (value: string) => {
      try {
        const cleaned = value.replace(/\\'/g, "'");
        return JSON.parse(cleaned);
      } catch {
        return undefined;
      }
    };

    const parsed = tryParse(serialized);
    namespaceData = parsed !== undefined ? parsed : namespaceData;

    if (typeof namespaceData === 'string') {
      const nested = tryParse(namespaceData);
      if (nested !== undefined) {
        namespaceData = nested;
      }
    }
  }
  return namespaceData;
}

async function registerScriptInKernel(
  kernelId: string,
  targetPath: string,
  scriptName: string,
  filePath: string,
): Promise<{ success: boolean; error?: string }> {
  if (!kernelId) {
    return { success: false, error: 'No kernel available' };
  }
  const kernel = kernelManager.getKernel(kernelId);
  if (!kernel || kernel.language !== 'python') {
    return { success: false, error: 'Kernel not available or not python' };
  }

  const args = {
    parent: targetPath,
    name: scriptName,
    file_path: filePath,
  };
  const encodedArgs = JSON.stringify(args);
  const code = [
    'import json',
    `args = json.loads(${JSON.stringify(encodedArgs)})`,
    'pdv_register_script(args.get("parent", ""), args.get("name"), args.get("file_path"))',
    'from IPython.display import JSON as PDVJSON',
    'PDVJSON({"ok": True})',
  ].join('\n');

  const result = await kernelManager.execute(kernelId, { code });
  if (result.error) {
    return { success: false, error: result.error };
  }
  return { success: true };
}

function sanitizeScriptName(name: string): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (/[<>:"|?*\r\n]/.test(trimmed)) return null;
  if (trimmed.length > 200) return null;
  const normalized = trimmed.replace(/\s+/g, '_');
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) return null;
  return normalized;
}

function openInEditor(filePath: string, language?: string): { success: boolean; error?: string } {
  try {
    const config = loadConfig();
    const editorCmd =
      (language === 'python'
        ? config.editors?.python
        : language === 'julia'
          ? config.editors?.julia
          : undefined) || config.editors?.default || 'open %s';
    const parts = editorCmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    if (parts.length === 0) {
      return { success: false, error: 'Invalid editor command' };
    }
    const cleaned = parts.map((part) => part.replace(/(^"|"$)/g, ''));
    const [command, ...rawArgs] = cleaned;
    const args = rawArgs.map((arg) => (arg === '%s' ? filePath : arg));
    if (!rawArgs.some((arg) => arg === '%s')) {
      args.push(filePath);
    }

    spawn(command, args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
    }).unref();

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseDefaultValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'True' || trimmed === 'true') {
    return true;
  }
  if (trimmed === 'False' || trimmed === 'false') {
    return false;
  }

  const numberPattern = /^-?\d+(\.\d+)?$/;
  if (numberPattern.test(trimmed)) {
    return Number(trimmed);
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}
