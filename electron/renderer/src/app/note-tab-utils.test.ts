import { describe, expect, it } from 'vitest';
import { getCleanNoteTabs, isDirtyNote } from './note-tab-utils';

describe('note-tab-utils', () => {
  it('detects dirty notes by comparing content to savedContent', () => {
    expect(
      isDirtyNote({
        id: 'notes.clean',
        name: 'clean',
        content: 'same',
        savedContent: 'same',
      }),
    ).toBe(false);

    expect(
      isDirtyNote({
        id: 'notes.dirty',
        name: 'dirty',
        content: 'unsaved edit',
        savedContent: 'saved version',
      }),
    ).toBe(true);
  });

  it('returns only clean notes for tree refresh reloads', () => {
    expect(
      getCleanNoteTabs([
        {
          id: 'notes.clean',
          name: 'clean',
          content: 'same',
          savedContent: 'same',
        },
        {
          id: 'notes.dirty',
          name: 'dirty',
          content: 'unsaved edit',
          savedContent: 'saved version',
        },
      ]),
    ).toEqual([
      {
        id: 'notes.clean',
        name: 'clean',
        content: 'same',
        savedContent: 'same',
      },
    ]);
  });
});
