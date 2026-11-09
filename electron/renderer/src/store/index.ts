/**
 * store/index.ts — the renderer's shared Zustand store.
 *
 * Discipline rule (#233, non-negotiable): shared state goes in the store,
 * local component state stays `useState`. A button's hover state is
 * `useState`; the active project's dirty flag is the store. Kernel/server
 * data is NOT store state — it lives in React Query (`../queries`).
 *
 * Slices are composed here; each slice lives in its own file as an
 * {@link AppSlice}. Store actions are identity-stable, so they can be passed
 * where React state setters were expected without churning effect deps.
 */

import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { createConsoleSlice, type ConsoleSlice } from './consoleSlice';
import { createDialogSlice, type DialogSlice } from './dialogSlice';
import { createRemoteSlice, type RemoteSlice } from './remoteSlice';
import { createSessionSlice, type SessionSlice } from './sessionSlice';

/** Union of all slice shapes; extended as slices land. */
export type AppStore = ConsoleSlice & DialogSlice & RemoteSlice & SessionSlice;

/** Helper type for defining a slice against the full store. */
export type AppSlice<T> = StateCreator<AppStore, [], [], T>;

export const useStore = create<AppStore>()((...args) => ({
  ...createConsoleSlice(...args),
  ...createDialogSlice(...args),
  ...createRemoteSlice(...args),
  ...createSessionSlice(...args),
}));
