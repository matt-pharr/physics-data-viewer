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
} from './ipc';
import { getKernelManager, resetKernelManager } from './kernel-manager';
import { loadConfig, updateConfig } from './config';
import { spawn } from 'child_process';
import { FileScanner } from './file-scanner';

// ============================================================================
// Kernel Manager Instance
// ============================================================================

const kernelManager = getKernelManager();
let currentConfig: Config = loadConfig();
let fileScanner: FileScanner | null = null;

function getFileScanner(): FileScanner {
  if (!fileScanner) {
    const config = loadConfig();
    const projectRoot = config.projectRoot || config.cwd || process.cwd();
    fileScanner = new FileScanner(projectRoot);
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
  // Tree Handlers
  // ============================================================================

  ipcMain.handle(IPC.tree.list, async (_event, path): Promise<TreeNode[]> => {
    console.log('[IPC] tree:list', path);

    const scanner = getFileScanner();

    if (!path || path === '' || path === 'root') {
      return scanner.scanAll();
    }

    return scanner.getChildren(path);
  });

  ipcMain.handle(IPC.tree.get, async (_event, id, options): Promise<unknown> => {
    console.log('[IPC] tree:get', id, options);
    if (id === 'data.array1') {
      return { type: 'ndarray', shape: [100, 100], dtype: 'float64', data: '<<binary>>' };
    }
    if (id === 'data.df1') {
      return { type: 'dataframe', columns: ['a', 'b', 'c', 'd', 'e'], rows: 1000 };
    }
    return null;
  });

  ipcMain.handle(IPC.tree.save, async (_event, id, value): Promise<boolean> => {
    console.log('[IPC] tree:save', id, value);
    return true;
  });

  const findNodeByPath = async (
    scanner: FileScanner,
    nodes: TreeNode[],
    targetPath: string,
  ): Promise<TreeNode | undefined> => {
    for (const node of nodes) {
      if (node.path === targetPath) {
        return node;
      }

      if (node.hasChildren && targetPath.startsWith(`${node.path}.`)) {
        const children = await scanner.getChildren(node.path);
        const found = await findNodeByPath(scanner, children, targetPath);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };

  // ============================================================================
  // Script Handlers
  // ============================================================================

  ipcMain.handle(
    IPC.script.run,
    async (_event, kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult> => {
      console.log('[IPC] script:run', kernelId, request);

      try {
        const kernel = kernelManager.getKernel(kernelId);
        if (!kernel) {
          return { success: false, error: `Kernel not found: ${kernelId}` };
        }

        const scanner = getFileScanner();
        const nodes = await scanner.scanAll();
        const scriptNode = await findNodeByPath(scanner, nodes, request.scriptPath);

        if (!scriptNode || !scriptNode._file_path) {
          return { success: false, error: `Script not found: ${request.scriptPath}` };
        }

        const language = kernel.language;
        const paramsJson = JSON.stringify(request.params ?? {});
        const paramsBase64 = Buffer.from(paramsJson, 'utf-8').toString('base64');
        const startTime = Date.now();
        let code = '';

        if (language === 'python') {
          const scriptPathLiteral = JSON.stringify(request.scriptPath);
          code = [
            'import json, base64',
            `_pdv_params = json.loads(base64.b64decode("${paramsBase64}").decode("utf-8"))`,
            `_pdv_result = tree.run_script(${scriptPathLiteral}, **_pdv_params)`,
            '_pdv_result',
          ].join('\\n');
        } else if (language === 'julia') {
          const scriptPathLiteral = JSON.stringify(request.scriptPath);
          const juliaParamsBase64 = Buffer.from(paramsJson, 'utf-8').toString('base64');
          code = [
            'using JSON, Base64',
            `_pdv_params = JSON.parse(String(Base64.base64decode("${juliaParamsBase64}")))`,
            // Convert JSON object keys to symbols for kwargs
            `_pdv_result = tree.run_script(${scriptPathLiteral}; (Symbol(k) => v for (k, v) in _pdv_params)... )`,
            '_pdv_result',
          ].join('\\n');
        } else {
          return { success: false, error: `Unsupported language: ${language}` };
        }

        const result = await kernelManager.execute(kernelId, { code });

        if (result.error) {
          return {
            success: false,
            error: result.error,
            duration: Date.now() - startTime,
          };
        }

        return {
          success: true,
          result: result.result,
          duration: Date.now() - startTime,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(IPC.script.edit, async (_event, scriptPath: string) => {
    console.log('[IPC] script:edit', scriptPath);

    try {
      const scanner = getFileScanner();
      const nodes = await scanner.scanAll();
      const scriptNode = await findNodeByPath(scanner, nodes, scriptPath);

      if (!scriptNode || !scriptNode._file_path) {
        return { success: false, error: `Script not found: ${scriptPath}` };
      }

      const filePath = scriptNode._file_path;
      const config = loadConfig();
      const language = scriptNode.language || 'python';
      const editorCmd =
        (config.editors && config.editors[language as 'python' | 'julia']) ||
        config.editors?.default ||
        'open %s';
      const parts = editorCmd.split(' ').filter(Boolean);
      const command = parts.shift();
      const args = parts.map((part) => (part.includes('%s') ? part.replace('%s', filePath) : part));

      if (!command) {
        return { success: false, error: 'Invalid editor command' };
      }

      const child = spawn(command, args.length > 0 ? args : [filePath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(IPC.script.get_params, async (_event, scriptPath: string) => {
    console.log('[IPC] script:get_params', scriptPath);

    try {
      const scanner = getFileScanner();
      const nodes = await scanner.scanAll();
      const scriptNode = await findNodeByPath(scanner, nodes, scriptPath);

      if (!scriptNode || !scriptNode._file_path) {
        return { success: false, error: `Script not found: ${scriptPath}` };
      }

      const content = fs.readFileSync(scriptNode._file_path, 'utf-8');
      const language = scriptNode.language;

      const params: ScriptParameter[] = [];

      if (language === 'python') {
        const match = content.match(/def\s+run\(([^)]*)\)/);
        if (match) {
          // Basic parser; complex signatures may require enhancements.
          const argsStr = match[1];
          const args = argsStr.split(',').map((a) => a.trim()).filter(Boolean);

          for (const arg of args) {
            if (arg === 'tree' || arg === 'self') continue;

            const [nameType, ...defaultParts] = arg.split('=');
            const [name, typeHint] = nameType.split(':').map((s) => s.trim());
            const defaultValue = defaultParts.length > 0 ? defaultParts.join('=').trim() : undefined;

            params.push({
              name,
              type: typeHint || 'unknown',
              default: defaultValue,
              required: !defaultValue,
            });
          }
        }
      } else if (language === 'julia') {
        const match = content.match(/function\s+run\(([^)]*)\)/);
        if (match) {
          // Basic parser; complex signatures may require enhancements.
          const argsStr = match[1];
          const args = argsStr.split(',').map((a) => a.trim()).filter(Boolean);

          for (const arg of args) {
            if (arg === 'tree') continue;

            const [nameType, defaultValue] = arg.split('=').map((s) => s.trim());
            const [name, typeHint] = nameType.split('::').map((s) => s.trim());

            params.push({
              name,
              type: typeHint || 'Any',
              default: defaultValue,
              required: !defaultValue,
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

  ipcMain.handle(IPC.script.reload, async () => {
    return { success: true };
  });

  // ============================================================================
  // File Handlers (unchanged from Step 2)
  // ============================================================================

  ipcMain.handle(IPC.files.read, async (_event, path, options): Promise<FileReadResult | null> => {
    console.log('[IPC] files:read', path, options);
    return {
      content: `# Stub content for ${path}\nprint("Hello, world!")`,
      size: 100,
      mtime: Date.now(),
    };
  });

  ipcMain.handle(IPC.files.write, async (_event, path, content): Promise<boolean> => {
    console.log('[IPC] files:write', path, typeof content === 'string' ? content.slice(0, 100) : '<binary>');
    return true;
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

  // ============================================================================

  console.log('[main] IPC handlers registered');
}
