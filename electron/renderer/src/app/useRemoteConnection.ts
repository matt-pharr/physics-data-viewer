/**
 * useRemoteConnection.ts — subscribe to remote connection status.
 *
 * Owned by `App`, like the other push subscriptions, and writes to the store
 * rather than to props (ARCHITECTURE.md §11.7, CLAUDE.md rule 7). Unlike
 * `useKernelSubscriptions` this is not keyed on a kernel: an ssh connection
 * outlives any one kernel and exists before any kernel does.
 *
 * It also hydrates once on mount. A renderer reload drops all client state
 * while the shell keeps holding the connection, so without that the UI would
 * show "not connected" over a live one.
 */

import { useEffect } from 'react';

import { useStore } from '../store';

/**
 * Keep the store's remote-connection state in sync with the shell.
 *
 * @returns Nothing. Subscribes on mount and unsubscribes on unmount.
 */
export function useRemoteConnection(): void {
  const applyRemoteStatus = useStore((s) => s.applyRemoteStatus);

  useEffect(() => {
    let cancelled = false;

    // The shell is the authority; the renderer may have just reloaded under
    // a connection that is already up.
    void window.pdv.remote
      .getStatus()
      .then((status) => {
        if (!cancelled) applyRemoteStatus(status);
      })
      .catch(() => {
        // A failed hydrate leaves the store at its idle default, which is
        // the safe reading — the UI offers to connect rather than claiming
        // a connection it cannot confirm.
      });

    const unsubscribe = window.pdv.remote.onStatus(applyRemoteStatus);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyRemoteStatus]);
}
