/**
 * Kernel Manager with real Jupyter integration.
 */

import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import {
  KernelManager as JupyterKernelManager,
  KernelMessage,
  ServerConnection,
  Kernel,
} from '@jupyterlab/services';
import { KernelSpecManager } from '@jupyterlab/services/lib/kernelspec';
import {
  KernelSpec,
  KernelInfo,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
} from './ipc';

interface ManagedKernel {
  info: KernelInfo;
  kernel: Kernel.IKernelConnection;
  spec: KernelSpec;
  startedAt: number;
  lastActivity: number;
  executionCount: number;
}

interface ExecutionOptions {
  silent?: boolean;
  storeHistory?: boolean;
  timeout?: number;
}

function loadInitCell(language: 'python' | 'julia'): string {
  const filename = language === 'python' ? 'python-init.py' : 'julia-init.jl';
  const initPath = path.join(__dirname, 'init', filename);

  try {
    if (fs.existsSync(initPath)) {
      return fs.readFileSync(initPath, 'utf-8');
    }
  } catch (error) {
    console.warn(`[KernelManager] Failed to load init cell for ${language}:`, error);
  }

  return language === 'python'
    ? '# Physics Data Viewer - Python kernel\nprint("PDV Python kernel ready")'
    : '# Physics Data Viewer - Julia kernel\nprintln("PDV Julia kernel ready")';
}

export class KernelManager {
  private kernels: Map<string, ManagedKernel> = new Map();
  private jupyterManager: JupyterKernelManager;
  private kernelSpecManager: KernelSpecManager;

  constructor() {
    const serverSettings = ServerConnection.makeSettings({
      WebSocket,
      token: process.env.JUPYTER_TOKEN || '',
      baseUrl: process.env.JUPYTER_BASE_URL,
    });

    this.jupyterManager = new JupyterKernelManager({ serverSettings });
    this.kernelSpecManager = new KernelSpecManager({ serverSettings });
  }

  async listSpecs(): Promise<KernelSpec[]> {
    const specs: KernelSpec[] = [];
    try {
      await this.kernelSpecManager.refreshSpecs();
      const models = this.kernelSpecManager.specs;
      if (models?.kernelspecs) {
        Object.values(models.kernelspecs).forEach((spec) => {
          specs.push({
            name: spec.name,
            displayName: spec.display_name,
            language: (spec.language as 'python' | 'julia') || 'python',
            argv: spec.argv,
            env: spec.env ?? undefined,
          });
        });
      }
    } catch (error) {
      console.warn('[KernelManager] Failed to list specs:', error);
    }
    return specs;
  }

  async list(): Promise<KernelInfo[]> {
    return Array.from(this.kernels.values()).map((k) => ({ ...k.info }));
  }

  async start(spec?: Partial<KernelSpec>): Promise<KernelInfo> {
    const language = spec?.language || 'python';
    const kernelName = spec?.name || (language === 'python' ? 'python3' : 'julia');

    const kernelInfo: KernelInfo = {
      id: '',
      name: kernelName,
      language,
      status: 'starting',
    };

    try {
      if (spec?.argv?.length) {
        if (language === 'python') {
          process.env.PYTHONEXECUTABLE = spec.argv[0];
        } else if (language === 'julia') {
          process.env.JULIA_EXECUTABLE = spec.argv[0];
        }
      }

      const kernel = await this.jupyterManager.startNew(
        { name: kernelName },
        { handleComms: false },
      );

      const managed: ManagedKernel = {
        info: { ...kernelInfo, id: kernel.id },
        kernel,
        spec: {
          name: kernelName,
          displayName: spec?.displayName || kernelName,
          language,
          argv: spec?.argv,
          env: spec?.env,
        },
        startedAt: Date.now(),
        lastActivity: Date.now(),
        executionCount: 0,
      };

      this.attachKernelSignals(managed);
      this.kernels.set(kernel.id, managed);

      await kernel.ready;
      const initCell = loadInitCell(language);
      await this.executeInternal(kernel.id, initCell, { silent: true, storeHistory: false });

      managed.info.status = 'idle';
      managed.lastActivity = Date.now();
      return { ...managed.info };
    } catch (error) {
      kernelInfo.status = 'error';
      console.error('[KernelManager] Failed to start kernel:', error);
      throw error;
    }
  }

  async stop(id: string): Promise<boolean> {
    const managed = this.kernels.get(id);
    if (!managed) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    try {
      await managed.kernel.shutdown();
    } catch (error) {
      console.error('[KernelManager] Failed to shutdown kernel:', error);
    } finally {
      this.kernels.delete(id);
    }
    return true;
  }

  async restart(id: string): Promise<KernelInfo> {
    const managed = this.kernels.get(id);
    if (!managed) {
      throw new Error(`Kernel not found: ${id}`);
    }

    managed.info.status = 'starting';
    await managed.kernel.restart();
    await managed.kernel.ready;

    const initCell = loadInitCell(managed.spec.language);
    await this.executeInternal(id, initCell, { silent: true, storeHistory: false });

    managed.info.status = 'idle';
    managed.executionCount = 0;
    return { ...managed.info };
  }

  async interrupt(id: string): Promise<boolean> {
    const managed = this.kernels.get(id);
    if (!managed) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    await managed.kernel.interrupt();
    managed.info.status = 'idle';
    managed.lastActivity = Date.now();
    return true;
  }

  async execute(id: string, request: KernelExecuteRequest): Promise<KernelExecuteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { error: `Kernel not found: ${id}`, duration: 0 };
    }

    return this.executeInternal(id, request.code, {
      storeHistory: true,
      timeout: 30000,
      silent: false,
      capture: request.capture,
    });
  }

  private async executeInternal(
    id: string,
    code: string,
    options: ExecutionOptions & { capture?: boolean } = {},
  ): Promise<KernelExecuteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      throw new Error(`Kernel not found: ${id}`);
    }

    const startTime = Date.now();
    managed.info.status = 'busy';
    managed.lastActivity = startTime;

    const result: KernelExecuteResult = {
      stdout: '',
      stderr: '',
      images: [],
      rich: {},
      result: undefined,
    };

    const future = managed.kernel.requestExecute(
      {
        code,
        stop_on_error: true,
        store_history: options.storeHistory !== false,
        allow_stdin: false,
        silent: options.silent === true,
      },
      false,
    );

    const timeoutMs = options.timeout ?? 30000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Execution timed out')), timeoutMs),
    );

    future.onIOPub = (msg) => {
      if (KernelMessage.isStreamMsg(msg)) {
        const content = msg.content;
        if (content.name === 'stdout') {
          result.stdout = (result.stdout || '') + content.text;
        } else if (content.name === 'stderr') {
          result.stderr = (result.stderr || '') + content.text;
        }
      } else if (KernelMessage.isExecuteResultMsg(msg)) {
        const content = msg.content;
        result.result = content.data['text/plain'] ?? content.data;
      } else if (KernelMessage.isDisplayDataMsg(msg)) {
        const content = msg.content;
        if (options.capture && content.data['image/png']) {
          result.images?.push({ mime: 'image/png', data: content.data['image/png'] as string });
        }
        if (content.data['text/html']) {
          result.rich = { ...(result.rich || {}), 'text/html': content.data['text/html'] as string };
        }
      } else if (KernelMessage.isErrorMsg(msg)) {
        const content = msg.content;
        result.error = `${content.ename}: ${content.evalue}`;
        if (content.traceback && content.traceback.length > 0) {
          result.stderr = (result.stderr || '') + content.traceback.join('\n');
        }
      }
    };

    try {
      const reply = await Promise.race([future.done, timeoutPromise]);
      managed.executionCount = reply?.content?.execution_count ?? managed.executionCount + 1;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      managed.info.status = 'idle';
      managed.lastActivity = Date.now();
      result.duration = Date.now() - startTime;

      if (result.stdout === '') result.stdout = undefined;
      if (result.stderr === '') result.stderr = undefined;
      if (result.images && result.images.length === 0) result.images = undefined;
      if (result.rich && Object.keys(result.rich).length === 0) result.rich = undefined;
    }

    return result;
  }

  async complete(id: string, code: string, cursorPos: number): Promise<KernelCompleteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    const reply = await managed.kernel.requestComplete({ code, cursor_pos: cursorPos });
    return {
      matches: reply.content.matches ?? [],
      cursor_start: reply.content.cursor_start,
      cursor_end: reply.content.cursor_end,
      metadata: reply.content.metadata as Record<string, unknown>,
    };
  }

  async inspect(id: string, code: string, cursorPos: number): Promise<KernelInspectResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { found: false };
    }

    const reply = await managed.kernel.requestInspect({
      code,
      cursor_pos: cursorPos,
      detail_level: 0,
    });

    if (reply.content.status === 'ok' && reply.content.found) {
      return {
        found: true,
        data: reply.content.data as Record<string, string>,
      };
    }

    return { found: false };
  }

  getKernel(id: string): KernelInfo | undefined {
    return this.kernels.get(id)?.info;
  }

  hasKernel(id: string): boolean {
    return this.kernels.has(id);
  }

  getExecutionCount(id: string): number {
    return this.kernels.get(id)?.executionCount || 0;
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.kernels.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }

  private attachKernelSignals(managed: ManagedKernel): void {
    managed.kernel.statusChanged.connect((_sender, status) => {
      if (status === 'idle' || status === 'busy' || status === 'starting') {
        managed.info.status = status;
      } else if (status === 'restarting') {
        managed.info.status = 'starting';
      } else if (status === 'dead' || status === 'terminating') {
        managed.info.status = 'dead';
      } else {
        managed.info.status = 'error';
      }
    });

    managed.kernel.disposed.connect(() => {
      managed.info.status = 'dead';
      this.kernels.delete(managed.info.id);
    });
  }
}

let instance: KernelManager | null = null;

export function getKernelManager(): KernelManager {
  if (!instance) {
    instance = new KernelManager();
  }
  return instance;
}

export function resetKernelManager(): void {
  if (instance) {
    void instance.shutdownAll();
    instance = null;
  }
}
