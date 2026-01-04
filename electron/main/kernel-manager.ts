import { KernelExecuteRequest, KernelExecuteResult } from './ipc';

/**
 * Stub KernelManager. 
 * Real implementation will use @jupyterlab/services to manage Jupyter kernels.
 */
export class KernelManager {
  private kernels: Map<string, { id: string; language: string }> = new Map();

  async list(): Promise<Array<{ id: string; language:  string }>> {
    return Array.from(this.kernels.values());
  }

  async start(spec?:  { language?:  string }): Promise<{ id: string }> {
    const id = `kernel-${Date.now()}`;
    this.kernels.set(id, { id, language: spec?.language || 'python' });
    return { id };
  }

  async stop(id: string): Promise<boolean> {
    return this.kernels.delete(id);
  }

  async execute(id: string, req: KernelExecuteRequest): Promise<KernelExecuteResult> {
    const start = Date.now();
    // Stub: echo the code back as stdout
    console.log(`[KernelManager] execute on ${id}: `, req.code);
    return {
      stdout: `[stub] Executed:  ${req.code}`,
      stderr: undefined,
      result: eval(req.code. includes('1+1') ? '2' : 'null'), // trivial stub
      error: undefined,
      duration: Date.now() - start,
    };
  }

  async interrupt(id: string): Promise<boolean> {
    console.log(`[KernelManager] interrupt ${id}`);
    return true;
  }

  async restart(id: string): Promise<boolean> {
    console.log(`[KernelManager] restart ${id}`);
    return true;
  }

  async complete(
    id: string,
    code: string,
    cursorPos: number
  ): Promise<{ matches: string[]; cursor_start: number; cursor_end: number }> {
    console.log(`[KernelManager] complete on ${id}`, code, cursorPos);
    return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
  }

  async inspect(
    id: string,
    code: string,
    cursorPos: number
  ): Promise<{ found: boolean; data?:  Record<string, string> }> {
    console. log(`[KernelManager] inspect on ${id}`, code, cursorPos);
    return { found: false };
  }
}