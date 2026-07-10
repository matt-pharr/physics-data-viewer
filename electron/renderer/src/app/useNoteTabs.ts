/**
 * app/useNoteTabs.ts — Markdown-note (Write tab) surface state and handlers.
 *
 * Owns the Code/Write pane selector, the open note-tab list, and the active
 * note tab, plus every handler that manipulates them: opening a markdown
 * tree node, live content edits, explicit saves, closing a tab (flushing
 * dirty content first), and flushing all dirty notes ahead of a project save.
 *
 * Does NOT talk to the kernel transport or filesystem directly — note
 * content moves through the preload bridge (`window.pdv.note.*`). Does NOT
 * decide *when* a project-level flush happens: App wires `flushDirtyNotes`
 * into useProjectWorkflow and clears the tab state itself on project
 * switches (via the returned setters).
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { LogEntry, NoteTab, TreeNodeData } from '../types';

/** Options for {@link useNoteTabs}. All setters correspond to App-level useState. */
interface UseNoteTabsOptions {
  /** ID of the currently running kernel, or null — note reads/writes require one. */
  currentKernelId: string | null;
  /** Appends console entries (used to surface note-save failures). */
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  /** Sets the error banner when opening a note fails. */
  setLastError: Dispatch<SetStateAction<string | undefined>>;
}

export function useNoteTabs(options: UseNoteTabsOptions) {
  const { currentKernelId, setLogs, setLastError } = options;

  // -- Write tab (markdown notes) state ------------------------------------
  const [activePane, setActivePane] = useState<'code' | 'write'>('code');
  const [noteTabs, setNoteTabs] = useState<NoteTab[]>([]);
  const noteTabsRef = useRef(noteTabs);
  useEffect(() => { noteTabsRef.current = noteTabs; }, [noteTabs]);
  const [activeNoteTabId, setActiveNoteTabId] = useState<string | null>(null);

  // -- Note (Write tab) helpers --------------------------------------------

  /** Open a markdown node in the Write tab, reading its content from disk. */
  const openNote = async (node: TreeNodeData) => {
    // If already open, just switch to it
    const existing = noteTabs.find((t) => t.id === node.path);
    if (existing) {
      setActiveNoteTabId(node.path);
      setActivePane('write');
      return;
    }

    if (!currentKernelId) return;

    try {
      const result = await window.pdv.note.read(currentKernelId, node.path);
      const content = result.success && result.content ? result.content : '';
      const newTab: NoteTab = {
        id: node.path,
        content,
        savedContent: content,
        name: node.key,
      };
      setNoteTabs((prev) => [...prev, newTab]);
      setActiveNoteTabId(node.path);
      setActivePane('write');
    } catch (error) {
      console.error('[App] Failed to read note:', error);
      setLastError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleNoteContentChange = (id: string, content: string) => {
    setNoteTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, content } : tab)),
    );
  };

  const handleNoteSave = async (id: string) => {
    const tab = noteTabs.find((t) => t.id === id);
    if (!tab || tab.content === tab.savedContent || !currentKernelId) return;
    try {
      await window.pdv.note.save(currentKernelId, tab.id, tab.content);
      setNoteTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, savedContent: t.content } : t)),
      );
    } catch (error) {
      // Surface the failure in the console — the tab stays dirty, so the
      // edits are not lost and the dirty dot keeps showing.
      const message = error instanceof Error ? error.message : String(error);
      setLogs((prev) => [...prev, {
        id: `note-save-error-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        error: `Failed to save note "${tab.name}": ${message}`,
      }]);
    }
  };

  /** Flush all dirty markdown notes to disk (called before project save). */
  const flushDirtyNotes = useCallback(async () => {
    if (!currentKernelId) return;
    const dirty = noteTabsRef.current.filter((t) => t.content !== t.savedContent);
    await Promise.all(
      dirty.map(async (tab) => {
        try {
          await window.pdv.note.save(currentKernelId, tab.id, tab.content);
          setNoteTabs((prev) =>
            prev.map((t) => (t.id === tab.id ? { ...t, savedContent: t.content } : t)),
          );
        } catch (error) {
          console.error('[App] Failed to flush note:', error);
        }
      }),
    );
  }, [currentKernelId]);

  const handleNoteCloseTab = async (id: string) => {
    // Closing a dirty note flushes it first — the note lives in the tree,
    // so a silent discard would lose real edits. Only ask the user when
    // the flush can't happen (no kernel) or fails.
    const tab = noteTabsRef.current.find((t) => t.id === id);
    if (tab && tab.content !== tab.savedContent) {
      let flushed = false;
      if (currentKernelId) {
        try {
          await window.pdv.note.save(currentKernelId, tab.id, tab.content);
          flushed = true;
        } catch (error) {
          console.error('[App] Failed to save note before closing:', error);
        }
      }
      if (!flushed) {
        const discard = window.confirm(
          `"${tab.name}" has unsaved changes that could not be saved. Close it anyway and discard them?`,
        );
        if (!discard) return;
      }
    }
    setNoteTabs((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      if (activeNoteTabId === id) {
        setActiveNoteTabId(updated.length > 0 ? updated[updated.length - 1].id : null);
      }
      if (updated.length === 0) {
        setActivePane('code');
      }
      return updated;
    });
  };

  return {
    activePane,
    setActivePane,
    noteTabs,
    setNoteTabs,
    activeNoteTabId,
    setActiveNoteTabId,
    openNote,
    handleNoteContentChange,
    handleNoteSave,
    handleNoteCloseTab,
    flushDirtyNotes,
  };
}
