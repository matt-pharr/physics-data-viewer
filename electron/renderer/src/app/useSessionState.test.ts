// @vitest-environment jsdom
/**
 * useSessionState.test.ts — the renderer's view of where its session lives.
 *
 * The interesting assertions are about what the *user* is shown: a status
 * that matches the server actually backing the window, and an honest marker
 * where output was lost rather than a transcript that looks continuous.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPdvMock } from '../test-fixtures/pdv-mock';
import { useStore } from '../store';
import { useSessionState } from './useSessionState';

const invalidateAllKernelState = vi.hoisted(() => vi.fn());
const resetSessionQueries = vi.hoisted(() => vi.fn());
vi.mock('../queries/invalidation', () => ({
  invalidateAllKernelState,
  resetSessionQueries,
}));

type SessionPush = Parameters<
  Parameters<typeof window.pdv.remote.onSessionState>[0]
>[0];

let emit: (push: SessionPush) => void;

beforeEach(() => {
  installPdvMock();
  invalidateAllKernelState.mockClear();
  resetSessionQueries.mockClear();
  useStore.setState({ connectionState: 'local', remoteHost: null, logs: [] });
  vi.mocked(window.pdv.remote.onSessionState).mockImplementation((cb) => {
    emit = cb;
    return () => undefined;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSessionState', () => {
  it('reports a remote session in the status bar', () => {
    renderHook(() => useSessionState('k1'));
    emit({ kind: 'remote', host: 'flux', state: 'connected' });

    expect(useStore.getState().connectionState).toBe('remote-connected');
    expect(useStore.getState().remoteHost).toBe('flux');
  });

  it('distinguishes reconnecting from lost', () => {
    renderHook(() => useSessionState('k1'));

    emit({ kind: 'remote', host: 'flux', state: 'reconnecting' });
    expect(useStore.getState().connectionState).toBe('remote-reconnecting');

    emit({ kind: 'remote', host: 'flux', state: 'auth-required' });
    expect(useStore.getState().connectionState).toBe('remote-lost');

    emit({ kind: 'remote', host: 'flux', state: 'disconnected' });
    expect(useStore.getState().connectionState).toBe('remote-lost');
  });

  it('clears the host when the session comes home', () => {
    renderHook(() => useSessionState('k1'));
    emit({ kind: 'remote', host: 'flux', state: 'connected' });
    emit({ kind: 'local', host: null, state: 'connected' });

    expect(useStore.getState().connectionState).toBe('local');
    expect(useStore.getState().remoteHost).toBeNull();
  });

  describe('resync', () => {
    it('rebuilds query-backed state', () => {
      renderHook(() => useSessionState('k1'));
      emit({ kind: 'remote', host: 'flux', state: 'connected', resync: true });

      expect(invalidateAllKernelState).toHaveBeenCalledWith('k1', 'reconnect');
    });

    it('invokes the resync callback so App can reload non-query state', () => {
      // App's `config` is component state; the query-cache reset cannot
      // reach it, and stale config after a swap means the next kernel
      // start uses the previous machine's interpreter and packages.
      const onResync = vi.fn();
      renderHook(() => useSessionState('k1', onResync));

      emit({ kind: 'remote', host: 'flux', state: 'connected' });
      expect(onResync).not.toHaveBeenCalled();

      emit({ kind: 'remote', host: 'flux', state: 'connected', resync: true });
      expect(onResync).toHaveBeenCalledOnce();
    });

    it('discards config and project too, not just kernel-scoped state', () => {
      // A pythonPath cached from the laptop is a path that does not exist on
      // the cluster, and the kernel start it feeds hangs rather than fails.
      // invalidateAllKernelState alone cannot reach it: config and project
      // are not kernel-scoped.
      renderHook(() => useSessionState('k1'));
      emit({ kind: 'remote', host: 'flux', state: 'connected', resync: true });

      expect(resetSessionQueries).toHaveBeenCalled();
    });

    it('marks the console where output was lost', () => {
      // Console output is append-only and genuinely unrecoverable — nothing
      // re-emits what was printed while nobody was listening. A silent gap
      // would read as the kernel having gone quiet.
      renderHook(() => useSessionState('k1'));
      emit({ kind: 'remote', host: 'flux', state: 'connected', resync: true });

      const logs = useStore.getState().logs;
      expect(logs).toHaveLength(1);
      expect(logs[0].stdout).toMatch(/output produced while disconnected may be missing/);
    });

    it('does not touch state on an ordinary reattach', () => {
      // A clean replay loses nothing, so a marker there would be a lie.
      renderHook(() => useSessionState('k1'));
      emit({ kind: 'remote', host: 'flux', state: 'connected' });

      expect(invalidateAllKernelState).not.toHaveBeenCalled();
      expect(resetSessionQueries).not.toHaveBeenCalled();
      expect(useStore.getState().logs).toEqual([]);
    });

    it('survives a resync with no kernel', () => {
      renderHook(() => useSessionState(null));
      expect(() =>
        emit({ kind: 'remote', host: 'flux', state: 'connected', resync: true }),
      ).not.toThrow();
      expect(invalidateAllKernelState).not.toHaveBeenCalled();
    });
  });
});
