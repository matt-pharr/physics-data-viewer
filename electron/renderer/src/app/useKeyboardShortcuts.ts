import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CellTab } from '../types';
import type { Shortcuts } from '../shortcuts';
import { matchesShortcut } from '../shortcuts';

type CellSnapshot = { tabs: CellTab[]; activeTabId: number };

interface UseKeyboardShortcutsOptions {
  shortcuts: Shortcuts;
  cellTabs: CellTab[];
  activeCellTab: number;
  cellUndoStack: React.MutableRefObject<CellSnapshot[]>;
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setSettingsInitialTab: Dispatch<SetStateAction<'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about'>>;
  toggleLeftSidebar: () => void;
  toggleEditorCollapsed: () => void;
  addCellTab: () => void;
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
  }, [shortcuts, toggleEditorCollapsed, toggleLeftSidebar]);
}
