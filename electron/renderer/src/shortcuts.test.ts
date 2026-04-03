import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  formatShortcutHint,
  matchesShortcut,
  resolveShortcuts,
} from './shortcuts';

function fakeKeyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {},
): KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

describe('resolveShortcuts', () => {
  it('returns defaults when undefined', () => {
    expect(resolveShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS);
  });

  it('merges partial overrides', () => {
    const merged = resolveShortcuts({ execute: 'Alt+Enter' });
    expect(merged.execute).toBe('Alt+Enter');
    expect(merged.treePrint).toBe(DEFAULT_SHORTCUTS.treePrint);
  });

  it('accepts full override object', () => {
    const override = {
      execute: 'B',
      newTab: 'C',
      closeTab: 'D',
      treeCopyPath: 'F',
      treeEditScript: 'G',
      treePrint: 'H',
    };
    expect(resolveShortcuts(override)).toEqual(override);
  });
});

describe('matchesShortcut', () => {
  it('matches CommandOrControl+Enter on ctrlKey environments', () => {
    const event = fakeKeyEvent('Enter', { ctrlKey: true });
    expect(matchesShortcut(event, 'CommandOrControl+Enter')).toBe(true);
  });

  it('matches single-letter shortcuts without modifiers', () => {
    expect(matchesShortcut(fakeKeyEvent('E'), 'E')).toBe(true);
  });

  it('does not match when required modifiers are missing', () => {
    const event = fakeKeyEvent('W', { ctrlKey: true });
    expect(matchesShortcut(event, 'CommandOrControl+Shift+W')).toBe(false);
  });

  it('never matches an empty shortcut string', () => {
    expect(matchesShortcut(fakeKeyEvent('E'), '')).toBe(false);
  });

  it('does not match single-key shortcuts when extra modifiers are held', () => {
    expect(matchesShortcut(fakeKeyEvent('e', { ctrlKey: true }), 'E')).toBe(false);
    expect(matchesShortcut(fakeKeyEvent('e', { metaKey: true }), 'E')).toBe(false);
    expect(matchesShortcut(fakeKeyEvent('e', { altKey: true }), 'E')).toBe(false);
    expect(matchesShortcut(fakeKeyEvent('p', { ctrlKey: true }), 'P')).toBe(false);
  });

  it('does not match modifier shortcuts when extra modifiers are held', () => {
    const event = fakeKeyEvent('Enter', { ctrlKey: true, altKey: true });
    expect(matchesShortcut(event, 'CommandOrControl+Enter')).toBe(false);
  });
});

describe('formatShortcutHint', () => {
  it('formats common shortcuts into readable hint text', () => {
    const hint = formatShortcutHint('CommandOrControl+Enter');
    expect(hint.includes('Ctrl+') || hint.includes('⌘')).toBe(true);
    expect(hint).toContain('↵');
  });
});
