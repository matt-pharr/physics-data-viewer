/**
 * client.ts — the renderer's singleton React Query client.
 *
 * All kernel/server state (tree listings, namespace queries, module lists,
 * completion results, ...) flows through this client; UI-only state lives in
 * the Zustand store (`../store`). Defaults here are tuned for a high-latency
 * transport: every queryFn is one `window.pdv.*` round trip, which in remote
 * mode is an SSH round trip, so refetches must be deliberate (push-driven
 * invalidation via `./invalidation`) rather than ambient.
 *
 * This file does not define query keys (see `./keys`) or invalidation policy
 * (see `./invalidation`).
 */

import { QueryClient } from '@tanstack/react-query';

/**
 * Stale-time constants, in milliseconds. Centralized so latency tuning is a
 * one-file edit; the round-trip-budget e2e test is the measuring stick.
 */
export const STALE_TIMES = {
  /** Tree listings: pushes invalidate promptly, so short is safe. */
  tree: 2_000,
  /** Monaco tree-path completions piggybacking on the tree cache. */
  treeCompletion: 3_000,
  /** Kernel code completions; invalidated on execute-finish. */
  complete: 10_000,
  /** Hover inspections; invalidated on execute-finish. */
  inspectHover: 30_000,
} as const;

/** How long inactive query data is retained for instant re-expansion. */
export const GC_TIME_MS = 5 * 60_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIMES.tree,
      gcTime: GC_TIME_MS,
      retry: 1,
      // Electron focus events are noisy and each refetch is a round trip;
      // refetching is driven by push invalidation instead.
      refetchOnWindowFocus: false,
      // Reconnect invalidation is explicit (invalidateAllKernelState with
      // reason 'reconnect'), not ambient.
      refetchOnReconnect: false,
    },
  },
});
