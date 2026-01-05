/**
 * Kernel Manager
 *
 * Manages Jupyter kernel lifecycles and execution.
 * Currently a stub implementation; will integrate @jupyterlab/services later.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  KernelSpec,
  KernelInfo,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
} from './ipc';

// 1x1 transparent PNG placeholder used when capture mode is requested
const STUB_IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ============================================================================
// Types
// ============================================================================

interface ManagedKernel {
  info: KernelInfo;
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

// ============================================================================
// Init Cell Loader
// ============================================================================

/**
 * Load init cell content for a given language
 */
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

  // Fallback minimal init
  if (language === 'python') {
    return '# Physics Data Viewer - Python kernel\nprint("PDV Python kernel ready")';
  }
  return '# Physics Data Viewer - Julia kernel\nprintln("PDV Julia kernel ready")';
}

// ============================================================================
// Kernel Manager Class
// ============================================================================

export class KernelManager {
  private kernels: Map<string, ManagedKernel> = new Map();
  private defaultSpecs: Map<string, KernelSpec> = new Map();

  constructor() {
    // Register default kernel specs
    this.defaultSpecs.set('python3', {
      name: 'python3',
      displayName: 'Python 3',
      language: 'python',
    });

    this.defaultSpecs.set('julia', {
      name: 'julia',
      displayName: 'Julia',
      language: 'julia',
    });

    console.log('[KernelManager] Initialized with default specs:', Array.from(this.defaultSpecs.keys()));
  }

  // ==========================================================================
  // Kernel Lifecycle
  // ==========================================================================

  /**
   * List all available kernel specs
   */
  async listSpecs(): Promise<KernelSpec[]> {
    // TODO: In real implementation, query jupyter kernelspec list
    return Array.from(this.defaultSpecs.values());
  }

  /**
   * List all running kernels
   */
  async list(): Promise<KernelInfo[]> {
    return Array.from(this.kernels.values()).map((k) => k.info);
  }

  /**
   * Start a new kernel
   */
  async start(spec?: Partial<KernelSpec>): Promise<KernelInfo> {
    const id = `kernel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const language = spec?.language || 'python';
    const name = spec?.name || (language === 'python' ? 'python3' : 'julia');

    const kernelSpec: KernelSpec = {
      name,
      displayName: spec?.displayName || this.defaultSpecs.get(name)?.displayName || name,
      language,
      argv: spec?.argv,
      env: spec?.env,
    };

    const kernelInfo: KernelInfo = {
      id,
      name,
      language,
      status: 'starting',
    };

    const managed: ManagedKernel = {
      info: kernelInfo,
      spec: kernelSpec,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      executionCount: 0,
    };

    this.kernels.set(id, managed);
    console.log(`[KernelManager] Starting kernel: ${id} (${language})`);

    // Simulate startup delay
    await this.simulateDelay(100);

    // Run init cell
    const initCell = loadInitCell(language);
    await this.executeInternal(id, initCell, { silent: true, storeHistory: false });

    // Update status to idle
    managed.info.status = 'idle';
    managed.lastActivity = Date.now();

    console.log(`[KernelManager] Kernel ready: ${id}`);
    return { ...managed.info };
  }

  /**
   * Stop a kernel
   */
  async stop(id: string): Promise<boolean> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    console.log(`[KernelManager] Stopping kernel: ${id}`);
    kernel.info.status = 'dead';
    this.kernels.delete(id);

    return true;
  }

  /**
   * Restart a kernel
   */
  async restart(id: string): Promise<KernelInfo> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      throw new Error(`Kernel not found: ${id}`);
    }

    console.log(`[KernelManager] Restarting kernel: ${id}`);

    // Mark as restarting
    kernel.info.status = 'starting';
    kernel.executionCount = 0;

    // Simulate restart delay
    await this.simulateDelay(200);

    // Re-run init cell
    const initCell = loadInitCell(kernel.spec.language);
    await this.executeInternal(id, initCell, { silent: true, storeHistory: false });

    // Mark as ready
    kernel.info.status = 'idle';
    kernel.lastActivity = Date.now();

    console.log(`[KernelManager] Kernel restarted: ${id}`);
    return { ...kernel.info };
  }

  /**
   * Interrupt a running kernel
   */
  async interrupt(id: string): Promise<boolean> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    console.log(`[KernelManager] Interrupting kernel: ${id}`);

    // In real implementation, send SIGINT to kernel process
    // For stub, just set status back to idle
    kernel.info.status = 'idle';
    kernel.lastActivity = Date.now();

    return true;
  }

  // ==========================================================================
  // Code Execution
  // ==========================================================================

  /**
   * Execute code in a kernel
   */
  async execute(id: string, request: KernelExecuteRequest): Promise<KernelExecuteResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      return {
        error: `Kernel not found: ${id}`,
        duration: 0,
      };
    }

    const startTime = Date.now();
    kernel.info.status = 'busy';
    kernel.lastActivity = Date.now();
    kernel.executionCount++;

    console.log(
      `[KernelManager] Execute [${kernel.executionCount}] on ${id}: `,
      request.code.slice(0, 100) + (request.code.length > 100 ? '...' : ''),
    );

    try {
      const result = await this.executeInternal(id, request.code, {
        storeHistory: true,
        timeout: 30000,
      });

      const hasPlotCall =
        !!request.code.match(/plt\.show\s*\(|matplotlib\.pyplot\.show\s*\(|plt\.savefig\s*\(/) ||
        !!result.stdout?.includes('plt.show');

      // Handle capture mode for plots
      if (request.capture && hasPlotCall) {
        result.images = [
          {
            mime: 'image/png',
            data: STUB_IMAGE_DATA, // 1x1 transparent PNG stub
          },
        ];
        result.stdout = result.stdout?.replace('plt.show()', '[Figure captured]') || '[Figure captured]';
      }

      result.duration = Date.now() - startTime;
      return result;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    } finally {
      kernel.info.status = 'idle';
      kernel.lastActivity = Date.now();
    }
  }

  /**
   * Internal execution (used for init cells and user code)
   */
  private async executeInternal(id: string, code: string, _options: ExecutionOptions = {}): Promise<KernelExecuteResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      throw new Error(`Kernel not found: ${id}`);
    }

    // Simulate execution delay based on code complexity
    const delay = Math.min(50 + code.length / 10, 500);
    await this.simulateDelay(delay);

    // Stub execution logic
    const result: KernelExecuteResult = {
      stdout: '',
      stderr: undefined,
      result: undefined,
      images: undefined,
      error: undefined,
    };

    // Parse and "execute" the code (stub logic)
    const lines = code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

    for (const line of lines) {
      const trimmed = line.trim();

      // Handle print statements
      const printMatch = trimmed.match(/^print\s*\(\s*["'](.*)["']\s*\)/);
      if (printMatch) {
        result.stdout = (result.stdout || '') + printMatch[1] + '\n';
        continue;
      }

      // Handle println (Julia)
      const printlnMatch = trimmed.match(/^println\s*\(\s*["'](.*)["']\s*\)/);
      if (printlnMatch) {
        result.stdout = (result.stdout || '') + printlnMatch[1] + '\n';
        continue;
      }

      // Handle matplotlib show for capture mode
      if (trimmed.startsWith('plt.show')) {
        result.stdout = (result.stdout || '') + 'plt.show()\n';
        continue;
      }

      // Handle simple expressions
      const expressionMatch = trimmed.match(/^(\d+\.?\d*)\s*([\+\-\*\/])\s*(\d+\.?\d*)$/);
      if (expressionMatch) {
        const left = Number.parseFloat(expressionMatch[1]);
        const operator = expressionMatch[2];
        const right = Number.parseFloat(expressionMatch[3]);

        switch (operator) {
          case '+':
            result.result = left + right;
            break;
          case '-':
            result.result = left - right;
            break;
          case '*':
            result.result = left * right;
            break;
          case '/':
            if (right === 0) {
              result.error = 'Division by zero';
            } else {
              result.result = left / right;
            }
            break;
          default:
            break;
        }
        continue;
      }

      // Handle variable assignments (just acknowledge)
      if (trimmed.match(/^[a-zA-Z_]\w*\s*=/)) {
        continue;
      }

      // Handle import statements
      if (trimmed.startsWith('import ') || trimmed.startsWith('using ') || trimmed.startsWith('from ')) {
        continue;
      }
    }

    // Clean up stdout
    if (result.stdout) {
      result.stdout = result.stdout.trim();
    } else {
      result.stdout = undefined;
    }

    return result;
  }

  // ==========================================================================
  // Completions and Inspection
  // ==========================================================================

  /**
   * Get code completions
   */
  async complete(id: string, code: string, cursorPos: number): Promise<KernelCompleteResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    console.log(`[KernelManager] Complete on ${id} at position ${cursorPos}`);

    // Stub: provide some common completions based on language
    const beforeCursor = code.slice(0, cursorPos);
    const wordMatch = beforeCursor.match(/[\w.]+$/);
    const word = wordMatch ? wordMatch[0] : '';
    const wordStart = cursorPos - word.length;

    let matches: string[] = [];

    if (kernel.spec.language === 'python') {
      const pythonKeywords = [
        'import',
        'from',
        'def',
        'class',
        'return',
        'if',
        'else',
        'elif',
        'for',
        'while',
        'try',
        'except',
        'finally',
        'with',
        'as',
        'lambda',
        'print',
        'len',
        'range',
        'list',
        'dict',
        'set',
        'tuple',
        'str',
        'int',
        'float',
        'numpy',
        'pandas',
        'matplotlib',
        'plt',
        'np',
        'pd',
      ];
      matches = pythonKeywords.filter((k) => k.startsWith(word) && k !== word);
    } else {
      const juliaKeywords = [
        'using',
        'import',
        'function',
        'end',
        'if',
        'else',
        'elseif',
        'for',
        'while',
        'try',
        'catch',
        'finally',
        'return',
        'struct',
        'println',
        'print',
        'length',
        'size',
        'typeof',
        'convert',
        'Array',
        'Vector',
        'Matrix',
        'Dict',
        'Set',
        'Tuple',
        'Plots',
        'DataFrames',
        'LinearAlgebra',
      ];
      matches = juliaKeywords.filter((k) => k.startsWith(word) && k !== word);
    }

    return {
      matches: matches.slice(0, 20),
      cursor_start: wordStart,
      cursor_end: cursorPos,
    };
  }

  /**
   * Inspect an object
   */
  async inspect(id: string, code: string, cursorPos: number): Promise<KernelInspectResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      return { found: false };
    }

    console.log(`[KernelManager] Inspect on ${id} at position ${cursorPos}`);

    // Extract word at cursor
    const beforeCursor = code.slice(0, cursorPos);
    const afterCursor = code.slice(cursorPos);
    const wordBefore = beforeCursor.match(/[\w.]+$/) || [''];
    const wordAfter = afterCursor.match(/^[\w.]*/) || [''];
    const word = wordBefore[0] + wordAfter[0];

    if (!word) {
      return { found: false };
    }

    // Stub: provide documentation for common items
    const docs: Record<string, string> = {
      print: 'print(*args, sep=" ", end="\\n")\n\nPrint objects to the text stream.',
      len: 'len(obj)\n\nReturn the number of items in a container.',
      range: 'range(stop) or range(start, stop, step)\n\nReturn an immutable sequence.',
      numpy: 'NumPy: The fundamental package for scientific computing with Python.',
      np: 'NumPy: The fundamental package for scientific computing with Python.',
      pandas: 'pandas: Powerful data structures for data analysis.',
      pd: 'pandas: Powerful data structures for data analysis.',
      matplotlib: 'Matplotlib: Comprehensive library for creating visualizations.',
      plt: 'matplotlib.pyplot: State-based interface to matplotlib.',
      println: 'println([io::IO], xs... )\n\nPrint objects to io followed by a newline.',
      Plots: 'Plots.jl: Powerful convenience for visualization in Julia.',
    };

    const docText = docs[word];
    if (docText) {
      return {
        found: true,
        data: {
          'text/plain': docText,
        },
      };
    }

    return { found: false };
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Get kernel info by ID
   */
  getKernel(id: string): KernelInfo | undefined {
    return this.kernels.get(id)?.info;
  }

  /**
   * Check if a kernel exists
   */
  hasKernel(id: string): boolean {
    return this.kernels.has(id);
  }

  /**
   * Get execution count for a kernel
   */
  getExecutionCount(id: string): number {
    return this.kernels.get(id)?.executionCount || 0;
  }

  /**
   * Shutdown all kernels
   */
  async shutdownAll(): Promise<void> {
    console.log(`[KernelManager] Shutting down ${this.kernels.size} kernel(s)`);
    const ids = Array.from(this.kernels.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }

  /**
   * Simulate async delay (for stub implementation)
   */
  private simulateDelay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

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
