/**
 * keys.ts — the single query-key factory for all React Query keys.
 *
 * Conventions:
 *  - Index 0 is a domain string; kernel-scoped keys carry the kernel id at
 *    index 1, so "everything for this kernel" is one predicate
 *    (`isKernelScopedKey` below, used by invalidateAllKernelState).
 *  - Components and providers never build key arrays inline — always through
 *    this factory, so invalidation stays targeted and greppable.
 */

/** Domains whose keys are kernel-scoped (kernel id at index 1). */
const KERNEL_SCOPED_DOMAINS = new Set([
  'tree',
  'tree-version',
  'namespace',
  'namespace-inspect',
  'modules',
  'completion',
  'inspect-hover',
]);

export const keys = {
  /** Children of one tree parent path ('' = root). */
  tree: (kernelId: string, path: string) => ['tree', kernelId, path] as const,
  /** Prefix key covering every tree listing for a kernel. */
  treeAll: (kernelId: string) => ['tree', kernelId] as const,
  /** Kernel-side tree version counter (poll demotion, Step 6). */
  treeVersion: (kernelId: string) => ['tree-version', kernelId] as const,
  /** Top-level namespace query; filtersHash distinguishes filter settings. */
  namespace: (kernelId: string, filtersHash: string) =>
    ['namespace', kernelId, filtersHash] as const,
  namespaceAll: (kernelId: string) => ['namespace', kernelId] as const,
  /** One expanded namespace node's children, keyed by its full expression. */
  namespaceInspect: (kernelId: string, expression: string) =>
    ['namespace-inspect', kernelId, expression] as const,
  namespaceInspectAll: (kernelId: string) => ['namespace-inspect', kernelId] as const,
  /** Imported/installed module listings. */
  modulesImported: (kernelId: string) => ['modules', kernelId, 'imported'] as const,
  modulesAll: (kernelId: string) => ['modules', kernelId] as const,
  /** Monaco kernel completions (fetchQuery-only; never mounted). */
  completion: (kernelId: string, contextHash: string) =>
    ['completion', kernelId, contextHash] as const,
  completionAll: (kernelId: string) => ['completion', kernelId] as const,
  /** Monaco hover inspections (fetchQuery-only; never mounted). */
  inspectHover: (kernelId: string, expressionHash: string) =>
    ['inspect-hover', kernelId, expressionHash] as const,
  inspectHoverAll: (kernelId: string) => ['inspect-hover', kernelId] as const,
} as const;

/**
 * Cheap stable hash (djb2) for long strings used inside query keys, so keys
 * stay short while still varying with their source text.
 *
 * @param text - Arbitrary string (e.g. editor contents up to the cursor).
 * @returns An unsigned-int hash rendered as a base-36 string.
 */
export function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Predicate matching every key scoped to the given kernel.
 *
 * @param queryKey - A query's key array.
 * @param kernelId - The kernel whose state is being targeted.
 * @returns true when the key belongs to a kernel-scoped domain for kernelId.
 */
export function isKernelScopedKey(queryKey: readonly unknown[], kernelId: string): boolean {
  return (
    typeof queryKey[0] === 'string' &&
    KERNEL_SCOPED_DOMAINS.has(queryKey[0]) &&
    queryKey[1] === kernelId
  );
}
