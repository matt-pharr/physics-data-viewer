/**
 * store.test.ts — unit tests for the shared Zustand store slices.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './index';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState(initialState, true);
});

describe('dialogSlice.closeTopmost', () => {
  it('closes the unsaved-changes confirm before the active dialog', () => {
    useStore.setState({
      activeDialog: { kind: 'saveAs' },
      pendingDirtyAction: { label: 'exit', run: vi.fn() },
    });

    expect(useStore.getState().closeTopmost()).toBe(true);
    expect(useStore.getState().pendingDirtyAction).toBeNull();
    expect(useStore.getState().activeDialog).toEqual({ kind: 'saveAs' });

    expect(useStore.getState().closeTopmost()).toBe(true);
    expect(useStore.getState().activeDialog).toBeNull();

    expect(useStore.getState().closeTopmost()).toBe(false);
  });

  it('openSettings sets visibility and optionally the tab', () => {
    useStore.getState().openSettings('runtime');
    expect(useStore.getState().showSettings).toBe(true);
    expect(useStore.getState().settingsInitialTab).toBe('runtime');

    useStore.getState().setShowSettings(false);
    useStore.getState().openSettings();
    // Tab preserved when not specified.
    expect(useStore.getState().settingsInitialTab).toBe('runtime');
  });

  it('setActiveDialog supports functional updates', () => {
    useStore.getState().setActiveDialog({ kind: 'newModule' });
    useStore
      .getState()
      .setActiveDialog((prev) => (prev?.kind === 'newModule' ? null : prev));
    expect(useStore.getState().activeDialog).toBeNull();
  });
});

describe('consoleSlice', () => {
  it('setLogs accepts values and updaters; clearLogs empties', () => {
    const entry = { id: 'a', timestamp: 0, code: '' };
    useStore.getState().setLogs([entry]);
    useStore.getState().setLogs((prev) => [...prev, { ...entry, id: 'b' }]);
    expect(useStore.getState().logs.map((l) => l.id)).toEqual(['a', 'b']);
    useStore.getState().clearLogs();
    expect(useStore.getState().logs).toEqual([]);
  });
});

describe('sessionSlice', () => {
  it('defaults to local and updates connection state', () => {
    expect(useStore.getState().connectionState).toBe('local');
    useStore.getState().setConnectionState('remote-reconnecting');
    expect(useStore.getState().connectionState).toBe('remote-reconnecting');
  });
});
