/**
 * remoteSlice.ts — state of the *ssh connection*, not of the session.
 *
 * That distinction is the whole point of this slice and is easy to get
 * wrong. Reaching a remote host over ssh and *running the session there* are
 * separate steps: until the shell swaps the active server onto that
 * connection, PDV is still a local session that happens to hold an open ssh
 * master. So this slice never touches `connectionState` or `remoteHost` in
 * {@link SessionSlice} — those describe where the session lives, and moving
 * them here would make the status bar claim a remote session that does not
 * exist yet.
 *
 * The connect log is deliberately kept out of the pushed status object and
 * accumulated here instead: each push carries only the new bytes, so the
 * transcript belongs to the client that is displaying it.
 */

import type { RemotePhase, RemoteStatus } from '../types';
import type { AppSlice } from './index';

export interface RemoteSlice {
  /** Where the current connection attempt stands. */
  remotePhase: RemotePhase;
  /** Host being connected to, or null when idle. */
  remoteConnectHost: string | null;
  /**
   * The machine that answered a load-balanced alias (e.g. `flux-login1`).
   * Worth showing: every channel rides one connection, so the session is
   * pinned to this node, and a later reconnect can land somewhere else.
   */
  remoteNode: string | null;
  /** Accumulated ssh output for the connection log (tail-bounded). */
  remoteLog: string;
  /** True when the prompt on screen wants something secret — mask the input. */
  remoteSecret: boolean;
  /** Latest human-readable message, set on success and failure. */
  remoteMessage: string | null;
  /** Identifies the attempt, so a late push cannot drive a newer one. */
  remoteAttemptId: string | null;
  /** Byte counts while the server bundle uploads, or null between transfers. */
  remoteProgress: { transferred: number; total: number } | null;
  /**
   * A session-level failure raised OUTSIDE the connect dialog (e.g. an
   * open-recent flow whose startSession failed). The dialog renders it in
   * its error slot — its own local error state can't be reached by other
   * flows, which is how a failure ended up visible nowhere.
   */
  remoteSessionError: string | null;

  /** Fold a pushed status into the slice. */
  applyRemoteStatus: (status: RemoteStatus) => void;
  /** Clear the log before starting a fresh attempt. */
  clearRemoteLog: () => void;
  /** Set or clear the session-level failure message. */
  setRemoteSessionError: (message: string | null) => void;
}

export const createRemoteSlice: AppSlice<RemoteSlice> = (set) => ({
  remotePhase: 'idle',
  remoteConnectHost: null,
  remoteNode: null,
  remoteLog: '',
  remoteSecret: false,
  remoteMessage: null,
  remoteAttemptId: null,
  remoteProgress: null,
  remoteSessionError: null,

  applyRemoteStatus: (status) =>
    set((state) => {
      // A new attempt starts a new log. Without this, a retry after a failed
      // sign-in shows the previous attempt's errors above the live output.
      const isNewAttempt =
        status.attemptId !== null && status.attemptId !== state.remoteAttemptId;
      const base = isNewAttempt ? '' : state.remoteLog;
      // Tail-bounded: a misbehaving remote step can emit one warning per
      // bundle file (thousands of lines), and rendering an unbounded log
      // wedged the connect dialog on a real cluster. The interesting part
      // of a connection log is always its tail.
      const grown = status.output ? base + status.output : base;
      const log = grown.length > 32_768 ? grown.slice(-32_768) : grown;
      return {
        remotePhase: status.phase,
        remoteConnectHost: status.host,
        remoteNode: status.node ?? (status.phase === 'connected' ? state.remoteNode : null),
        remoteLog: log,
        remoteSecret: status.secret ?? false,
        remoteMessage: status.message ?? (isNewAttempt ? null : state.remoteMessage),
        remoteAttemptId: status.attemptId,
        // Cleared whenever a push carries none, so a finished upload does not
        // leave a bar frozen at its last value while a later stage runs.
        remoteProgress: status.progress ?? null,
      };
    }),

  clearRemoteLog: () => set({ remoteLog: '', remoteMessage: null, remoteSessionError: null }),

  setRemoteSessionError: (message) => set({ remoteSessionError: message }),
});
