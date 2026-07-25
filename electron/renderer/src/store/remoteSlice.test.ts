/**
 * remoteSlice.test.ts — remote connection state folding.
 *
 * The assertion that matters most is the negative one: connecting over ssh
 * must NOT flip `connectionState` or `remoteHost`. Those describe where the
 * *session* runs, and the session does not move to the host merely because a
 * connection opened. Getting that wrong makes the status bar announce a
 * remote session while every kernel call still runs locally.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useStore } from './index';
import type { RemoteStatus } from '../types';

function status(partial: Partial<RemoteStatus>): RemoteStatus {
  return { phase: 'idle', host: null, attemptId: null, ...partial };
}

beforeEach(() => {
  useStore.setState({
    remotePhase: 'idle',
    remoteConnectHost: null,
    remoteNode: null,
    remoteLog: '',
    remoteSecret: false,
    remoteMessage: null,
    remoteAttemptId: null,
    connectionState: 'local',
    remoteHost: null,
  });
});

describe('applyRemoteStatus', () => {
  it('does not move the session when a connection opens', () => {
    useStore.getState().applyRemoteStatus(
      status({ phase: 'connected', host: 'flux', attemptId: 'a1', node: 'flux-login1' }),
    );
    const state = useStore.getState();
    expect(state.remotePhase).toBe('connected');
    expect(state.remoteNode).toBe('flux-login1');
    // The session still runs locally — only the ssh link is up.
    expect(state.connectionState).toBe('local');
    expect(state.remoteHost).toBeNull();
  });

  it('accumulates streamed output across pushes', () => {
    const s = useStore.getState();
    s.applyRemoteStatus(status({ phase: 'connecting', host: 'flux', attemptId: 'a1' }));
    s.applyRemoteStatus(status({ phase: 'prompting', host: 'flux', attemptId: 'a1', output: 'Duo ' }));
    s.applyRemoteStatus(status({ phase: 'prompting', host: 'flux', attemptId: 'a1', output: 'push?' }));
    expect(useStore.getState().remoteLog).toBe('Duo push?');
  });

  it('starts a fresh log for a new attempt', () => {
    const s = useStore.getState();
    s.applyRemoteStatus(status({ phase: 'prompting', host: 'flux', attemptId: 'a1', output: 'old failure' }));
    s.applyRemoteStatus(status({ phase: 'connecting', host: 'flux', attemptId: 'a2' }));
    // A retry must not show the previous attempt's errors above live output.
    expect(useStore.getState().remoteLog).toBe('');
  });

  it('tracks the mask flag so a secret prompt is never shown', () => {
    const s = useStore.getState();
    s.applyRemoteStatus(status({ phase: 'prompting', host: 'flux', attemptId: 'a1', secret: true }));
    expect(useStore.getState().remoteSecret).toBe(true);
    s.applyRemoteStatus(status({ phase: 'prompting', host: 'flux', attemptId: 'a1', output: 'ok' }));
    expect(useStore.getState().remoteSecret).toBe(false);
  });

  it('keeps the node while connected but drops it on disconnect', () => {
    const s = useStore.getState();
    s.applyRemoteStatus(status({ phase: 'connected', host: 'flux', attemptId: 'a1', node: 'flux-login1' }));
    s.applyRemoteStatus(status({ phase: 'connected', host: 'flux', attemptId: 'a1' }));
    expect(useStore.getState().remoteNode).toBe('flux-login1');
    s.applyRemoteStatus(status({ phase: 'idle' }));
    expect(useStore.getState().remoteNode).toBeNull();
  });

  it('surfaces the failure message', () => {
    useStore.getState().applyRemoteStatus(
      status({ phase: 'failed', host: 'flux', attemptId: 'a1', message: 'Could not connect' }),
    );
    expect(useStore.getState().remoteMessage).toBe('Could not connect');
  });
});

describe('clearRemoteLog', () => {
  it('empties the log and the last message', () => {
    const s = useStore.getState();
    s.applyRemoteStatus(status({ phase: 'failed', host: 'flux', attemptId: 'a1', output: 'x', message: 'bad' }));
    s.clearRemoteLog();
    expect(useStore.getState().remoteLog).toBe('');
    expect(useStore.getState().remoteMessage).toBeNull();
  });
});
