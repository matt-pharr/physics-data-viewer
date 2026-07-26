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

import { invalidateAllKernelState } from '../queries/invalidation';
import { useStore } from '../store';
import type { ConnectionState } from '../store/sessionSlice';

/** Session-state payload as delivered by the preload bridge. */
interface SessionStatePush {
  kind: 'local' | 'remote';
  host: string | null;
  state: 'connected' | 'reconnecting' | 'auth-required' | 'disconnected';
  resync?: boolean;
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
 * @returns Nothing.
 */
export function useSessionState(currentKernelId: string | null): void {
  const setConnectionState = useStore((s) => s.setConnectionState);
  const setRemoteHost = useStore((s) => s.setRemoteHost);

  useEffect(() => {
    const unsubscribe = window.pdv.remote.onSessionState((push) => {
      const state = push as SessionStatePush;
      setConnectionState(toConnectionState(state));
      setRemoteHost(state.kind === 'remote' ? state.host : null);

      if (!state.resync) return;
      // Rebuild everything: the server backing this window either changed or
      // could not resume our view.
      if (currentKernelId) {
        invalidateAllKernelState(currentKernelId, 'reconnect');
      }
      useStore.getState().setLogs((prev) => [
        ...prev,
        {
          id: `reconnect-${String(Date.now())}`,
          timestamp: Date.now(),
          code: '',
          stdout:
            '── reconnected; output produced while disconnected may be missing ──',
        },
      ]);
    });
    return unsubscribe;
  }, [currentKernelId, setConnectionState, setRemoteHost]);
}
