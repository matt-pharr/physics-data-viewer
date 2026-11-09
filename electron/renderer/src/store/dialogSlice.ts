/**
 * dialogSlice.ts — app-level modal state.
 *
 * One dialog at a time: every app-level dialog is a variant of the
 * `ActiveDialog` union, so opening one implicitly closes the previous.
 * `closeTopmost` encodes the whole Escape priority in one place:
 * unsaved-changes confirm first, then the active dialog. SettingsDialog
 * stays outside the union (it suppresses Escape while recording shortcuts)
 * but its visibility lives here; the welcome overlay is not
 * Escape-dismissible and stays with the welcome state.
 */

import type { TreeNodeData } from '../types';
import type { AppSlice } from './index';

/** Union of all app-level modals that occupy the single dialog slot. */
export type ActiveDialog =
  | { kind: 'script'; node: TreeNodeData }
  | { kind: 'rename'; path: string; nodeKey: string }
  | { kind: 'move'; path: string; nodeType: string }
  | { kind: 'duplicate'; path: string; nodeType: string }
  | { kind: 'createNode'; parentPath: string }
  | { kind: 'createScript'; parentPath: string }
  | { kind: 'createNote'; parentPath: string }
  | { kind: 'createGui'; parentPath: string }
  | { kind: 'createLib'; parentPath: string }
  | { kind: 'newModule' }
  | {
      kind: 'moduleMetadata';
      alias: string;
      name: string;
      version: string;
      description?: string;
      language?: 'python' | 'julia';
    }
  | { kind: 'importModule' }
  | { kind: 'saveAs' }
  | { kind: 'newProject' }
  | { kind: 'newJuliaProject' }
  // Connects to a host; it does NOT move the session there. See remoteSlice.
  | { kind: 'remoteConnect' };

export type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about';

export interface DialogSlice {
  activeDialog: ActiveDialog | null;
  showSettings: boolean;
  settingsInitialTab: SettingsTab;
  /** Pending destructive action awaiting the unsaved-changes confirm. */
  pendingDirtyAction: { label: string; run: () => void } | null;
  /** React-setter-compatible updater (accepts a value or a function). */
  setActiveDialog: (
    update: ActiveDialog | null | ((prev: ActiveDialog | null) => ActiveDialog | null),
  ) => void;
  closeDialog: () => void;
  /** Open Settings, optionally on a specific tab. */
  openSettings: (tab?: SettingsTab) => void;
  setShowSettings: (visible: boolean) => void;
  setPendingDirtyAction: (action: { label: string; run: () => void } | null) => void;
  /**
   * Close the highest-priority open modal (unsaved-changes confirm, then the
   * active dialog). Returns true if something was closed — the global Escape
   * handler uses this to decide whether to swallow the key.
   */
  closeTopmost: () => boolean;
}

export const createDialogSlice: AppSlice<DialogSlice> = (set, get) => ({
  activeDialog: null,
  showSettings: false,
  settingsInitialTab: 'general',
  pendingDirtyAction: null,
  setActiveDialog: (update) =>
    set((state) => ({
      activeDialog: typeof update === 'function' ? update(state.activeDialog) : update,
    })),
  closeDialog: () => set({ activeDialog: null }),
  openSettings: (tab) =>
    set((state) => ({
      showSettings: true,
      settingsInitialTab: tab ?? state.settingsInitialTab,
    })),
  setShowSettings: (visible) => set({ showSettings: visible }),
  setPendingDirtyAction: (action) => set({ pendingDirtyAction: action }),
  closeTopmost: () => {
    const { pendingDirtyAction, activeDialog } = get();
    if (pendingDirtyAction) {
      set({ pendingDirtyAction: null });
      return true;
    }
    if (activeDialog) {
      set({ activeDialog: null });
      return true;
    }
    return false;
  },
});
