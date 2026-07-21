/**
 * sessionSlice.ts — session-level connection state.
 *
 * `connectionState` is the renderer surface for remote mode (roadmap Phase
 * 3): 'local' today, driven by the SSH connection state machine once remote
 * sessions land. StatusBar subscribes and renders nothing for 'local'.
 *
 * The remaining session fields (kernel id/status, project dir/name, dirty
 * flag) still live in App's useState and migrate here incrementally — they
 * are threaded through hook option bags whose rewiring is deliberately kept
 * out of the latency-focused steps.
 */

import type { AppSlice } from './index';

export type ConnectionState =
  | 'local'
  | 'remote-connected'
  | 'remote-reconnecting'
  | 'remote-lost';

export interface SessionSlice {
  connectionState: ConnectionState;
  setConnectionState: (state: ConnectionState) => void;
}

export const createSessionSlice: AppSlice<SessionSlice> = (set) => ({
  connectionState: 'local',
  setConnectionState: (connectionState) => set({ connectionState }),
});
