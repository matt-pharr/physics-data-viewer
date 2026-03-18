import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CellTab } from '../types';
import type { Shortcuts } from '../shortcuts';
import { matchesShortcut } from '../shortcuts';

type CellSnapshot = { tabs: CellTab[]; activeTabId: number };

/** Options for {@link useKeyboardShortcuts}. Values accessed via internal refs to avoid re-registration. */
interface UseKeyboardShortcutsOptions {
  /** User-configurable shortcut bindings (from config.settings.shortcuts). */
  shortcuts: Shortcuts;
  /** Current code cell tabs (read via ref for Cmd+1–9 navigation). */
  cellTabs: CellTab[];
  /** Active tab ID (read via ref for close-tab shortcut). */
  activeCellTab: number;
  /** Stack of tab snapshots for Cmd+Z cell undo (shared with App). */
  cellUndoStack: React.MutableRefObject<CellSnapshot[]>;
  /** Setter for code cell tabs (used by Cmd+Z undo restore). */
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  /** Setter for active tab (used by Cmd+Z undo and Cmd+1–9 navigation). */
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  /** Opens the SettingsDialog. */
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  /** Controls which tab the SettingsDialog opens to. */
  setSettingsInitialTab: Dispatch<SetStateAction<'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about'>>;
  /** Toggles the left sidebar panel (Cmd+B). */
  toggleLeftSidebar: () => void;
  /** Toggles the code editor collapsed state (Cmd+J). */
  toggleEditorCollapsed: () => void;
  /** Opens the Import Module dialog (Cmd+I). */
  setShowImportModule: Dispatch<SetStateAction<boolean>>;
  /** Creates a new code cell tab (configurable shortcut). */
  addCellTab: () => void;
  /** Closes the tab with the given ID (configurable shortcut). */
  removeCellTab: (id: number) => void;
}

/**
 * Register global keyboard shortcuts for the App component.
 *
 * Handles Cmd+Z cell undo, tab navigation (Cmd+1–9), configurable shortcuts
 * (new tab, close tab, settings, close window), and hardcoded toggles
 * (Cmd+B sidebar, Cmd+J editor).
 *
 * Uses internal refs to avoid re-registering the keydown listener on every
 * state change — only re-registers when `shortcuts` or toggle callbacks change.
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): void {
  const {
    shortcuts,
    cellUndoStack,
    setCellTabs,
    setActiveCellTab,
    setShowSettings,
    setSettingsInitialTab,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    setShowImportModule,
  } = options;

  // Refs to avoid re-registering the listener when these values change
  const addCellTabRef = useRef(options.addCellTab);
  const removeCellTabRef = useRef(options.removeCellTab);
  const activeCellTabRef = useRef(options.activeCellTab);
  const cellTabsRef = useRef(options.cellTabs);

  useEffect(() => { addCellTabRef.current = options.addCellTab; });
  useEffect(() => { removeCellTabRef.current = options.removeCellTab; });
  useEffect(() => { activeCellTabRef.current = options.activeCellTab; }, [options.activeCellTab]);
  useEffect(() => { cellTabsRef.current = options.cellTabs; }, [options.cellTabs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      // Cmd+Z outside Monaco → undo last cell clear/close
      // Monaco sets its editor textarea as the active element; when it has focus
      // it handles Cmd+Z itself before this listener sees it.
      const isMonacoFocused = (document.activeElement as HTMLElement)
        ?.closest('.monaco-editor') != null;
      if (!isMonacoFocused && (event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey && !event.altKey) {
        const snapshot = cellUndoStack.current[cellUndoStack.current.length - 1];
        if (snapshot) {
          event.preventDefault();
          cellUndoStack.current = cellUndoStack.current.slice(0, -1);
          setCellTabs(snapshot.tabs);
          setActiveCellTab(snapshot.activeTabId);
        }
        return;
      }

      if (matchesShortcut(event, shortcuts.openSettings)) {
        event.preventDefault();
        setSettingsInitialTab('general');
        setShowSettings(true);
      }
      if (matchesShortcut(event, shortcuts.newTab)) {
        event.preventDefault();
        addCellTabRef.current();
      }
      if (matchesShortcut(event, shortcuts.closeTab)) {
        event.preventDefault();
        removeCellTabRef.current(activeCellTabRef.current);
      }
      if (matchesShortcut(event, shortcuts.closeWindow)) {
        event.preventDefault();
        window.close();
      }
      // Cmd+I: open Import Module dialog
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'i') {
        event.preventDefault();
        setShowImportModule(true);
      }
      // Cmd+B: toggle left sidebar
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'b') {
        event.preventDefault();
        toggleLeftSidebar();
      }
      // Cmd+J: toggle code editor
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'j') {
        event.preventDefault();
        toggleEditorCollapsed();
      }
      // Cmd+1–9 → go to nth tab; Cmd+0 → go to last tab
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        const digit = event.key;
        if (digit >= '1' && digit <= '9') {
          event.preventDefault();
          const t = cellTabsRef.current;
          const target = t[Math.min(Number(digit) - 1, t.length - 1)];
          if (target) setActiveCellTab(target.id);
        } else if (digit === '0') {
          event.preventDefault();
          const t = cellTabsRef.current;
          if (t.length) setActiveCellTab(t[t.length - 1].id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts, toggleEditorCollapsed, toggleLeftSidebar, setShowImportModule]);
}
