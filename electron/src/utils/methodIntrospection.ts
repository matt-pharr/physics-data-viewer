import { BackendClient, InvokeResult, MethodInfo } from '../api/client';
import { backendPath } from './dataFormatting';

export class MethodIntrospector {
  private cache = new Map<string, MethodInfo[]>();
  private client: BackendClient;

  constructor(client: BackendClient) {
    this.client = client;
  }

  private cacheKey(sessionId: string, path: string[]): string {
    return `${sessionId}:${backendPath(path).join('.')}`;
  }

  async getMethods(sessionId: string, path: string[]): Promise<MethodInfo[]> {
    const key = this.cacheKey(sessionId, path);
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    const methods = await this.client.listMethods(sessionId, backendPath(path));
    this.cache.set(key, methods);
    return methods;
  }

  clear(): void {
    this.cache.clear();
  }
}

export function pickDefaultMethod(methods: MethodInfo[]): MethodInfo | undefined {
  return methods.find((m) => !m.requires_arguments) ?? methods[0];
}

export function normalizeInvokeResult(result: InvokeResult) {
  const resultType = result.result_type || 'object';
  const isError = Boolean(result.error);
  return {
    methodName: result.method_name,
    resultType: isError ? 'error' : resultType,
    content: result.result,
    error: result.error,
    traceback: result.traceback,
  };
}
