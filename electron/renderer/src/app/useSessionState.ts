/**
 * useSessionState.ts — keep the renderer honest about where its session is.
 *
 * Subscribes to the session-state push and folds it into
 * {@link SessionSlice}, so the status bar reflects the server that is
 * actually backing this window rather than the one it started with.
 *
 * The `resync` flag is the part that matters. Query invalidation rebuilds
 * React-Query-backed state (tree, namespace, modules), which covers most of
 * what the user sees. Console output is the exception: it is append-only and
 * genuinely unrecoverable, because nothing re-emits what was printed while
 * nobody was listening. Rather than pretend otherwise, a resync leaves a
 * visible marker in the console so a gap in the transcript is legible
 * instead of looking like the kernel went quiet.
 */

import { useEffect } from 'react';

import {
  invalidateAllKernelState,
  resetSessionQueries,
} from '../queries/invalidation';
import { useStore } from '../store';
import type { ConnectionState } from '../store/sessionSlice';

/** Session-state payload as delivered by the preload bridge. */
interface SessionStatePush {
  kind: 'local' | 'remote';
  host: string | null;
  state: 'connected' | 'reconnecting' | 'auth-required' | 'disconnected';
  resync?: boolean;
  cause?: 'moved' | 'recovered';
}

/** Map a pushed session state onto the store's connection state. */
function toConnectionState(push: SessionStatePush): ConnectionState {
  if (push.kind === 'local') return 'local';
  switch (push.state) {
    case 'connected':
      return 'remote-connected';
    case 'reconnecting':
      return 'remote-reconnecting';
    default:
      // auth-required and disconnected are both "we cannot reach it" as far
      // as the status bar is concerned; the connect dialog carries the
      // detail and the remedy.
      return 'remote-lost';
  }
}

/**
 * Subscribe to session-state pushes for the lifetime of the app.
 *
 * @param currentKernelId - Kernel to invalidate on a resync, or null.
 * @param onResync - Called on every resync AFTER the query cache is reset,
 *   with the push's cause: 'moved' (the server behind this window changed —
 *   any previous kernel id is meaningless) or 'recovered' (same session,
 *   view rebuilt).
 *   App uses it to reload state that lives outside React Query — its
 *   `config` useState in particular, whose `pythonPath`/`defaultPackages`
 *   would otherwise still be the previous machine's (clearing the query
 *   cache cannot reach component state, and a kernel started with the
 *   laptop's interpreter path on a cluster was a real observed failure).
 * @returns Nothing.
 */
export function useSessionState(
  currentKernelId: string | null,
  onResync?: (cause?: 'moved' | 'recovered') => void,
): void {
  const setConnectionState = useStore((s) => s.setConnectionState);
  const setRemoteHost = useStore((s) => s.setRemoteHost);

  useEffect(() => {
    const unsubscribe = window.pdv.remote.onSessionState((push) => {
      const state = push as SessionStatePush;
      setConnectionState(toConnectionState(state));
      setRemoteHost(state.kind === 'remote' ? state.host : null);

      if (!state.resync) return;
      // Rebuild everything: the server backing this window either changed or
      // could not resume our view. This must include config and project,
      // which are not kernel-scoped — a `pythonPath` cached from the laptop
      // is meaningless on a cluster, and starting a kernel with it hangs
      // rather than failing.
      resetSessionQueries();
      if (currentKernelId) {
        invalidateAllKernelState(currentKernelId, 'reconnect');
      }
      onResync?.(state.cause);
      // A deliberate move is not an outage — "output may be missing" after
      // clicking "Run session on <host>" read as data loss to a real user.
      const marker =
        state.cause === 'moved'
          ? state.kind === 'remote'
            ? `── session moved to ${state.host ?? 'the remote host'} ──`
            : '── session moved back to this computer ──'
          : '── reconnected; output produced while disconnected may be missing ──';
      useStore.getState().setLogs((prev) => [
        ...prev,
        {
          id: `reconnect-${String(Date.now())}`,
          timestamp: Date.now(),
          code: '',
          stdout: marker,
        },
      ]);
    });
    return unsubscribe;
  }, [currentKernelId, onResync, setConnectionState, setRemoteHost]);
}
