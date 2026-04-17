import type { NoteTab } from '../types';

/** Returns true when the note has unsaved edits in the Write tab. */
export function isDirtyNote(tab: NoteTab): boolean {
  return tab.content !== tab.savedContent;
}

/** Returns the subset of open notes that can be safely reloaded from disk. */
export function getCleanNoteTabs(tabs: NoteTab[]): NoteTab[] {
  return tabs.filter((tab) => !isDirtyNote(tab));
}
