export interface FormattedValue {
  preview: string;
  typeName: string;
  capabilities: Record<string, boolean>;
  isCustom: boolean;
}

const SAFE_PREVIEW_LENGTH = 120;

function safeString(value: unknown): string {
  try {
    const repr = typeof value === 'string' ? value : JSON.stringify(value, null, 0);
    if (repr === undefined) {
      return String(value);
    }
    return repr;
  } catch {
    return String(value);
  }
}

export function describeCapabilities(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') {
    return { show: false, plot: false };
  }
  const record = value as Record<string, unknown>;
  return {
    show: typeof record['show'] === 'function',
    plot: typeof record['plot'] === 'function',
  };
}

export function formatValue(value: unknown): FormattedValue {
  const capabilities = describeCapabilities(value);
  const isCustom = Boolean(capabilities.show || capabilities.plot);
  const rawPreview = safeString(value);
  const preview = rawPreview.length > SAFE_PREVIEW_LENGTH ? `${rawPreview.slice(0, SAFE_PREVIEW_LENGTH)}…` : rawPreview;

  return {
    preview,
    typeName: value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value,
    capabilities,
    isCustom,
  };
}

export function backendPath(path: string[]): string[] {
  if (path.length > 0 && path[0] === 'root') {
    return path.slice(1);
  }
  return path;
}
