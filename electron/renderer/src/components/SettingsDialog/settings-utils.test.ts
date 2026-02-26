import { describe, expect, it } from 'vitest';
import {
  IS_MAC,
  buildShortcutString,
  normalizeShortcut,
  parseShortcutTokens,
  tokenToLabel,
} from './utils';

function fakeEvent(
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

describe('tokenToLabel', () => {
  it('maps known modifier and special tokens', () => {
    expect(tokenToLabel('CommandOrControl')).toBe(IS_MAC ? '⌘' : 'Ctrl');
    expect(tokenToLabel('shift')).toBe('⇧');
    expect(tokenToLabel('enter')).toBe('↵');
    expect(tokenToLabel('escape')).toBe('Esc');
    expect(tokenToLabel('comma')).toBe(',');
  });

  it('uppercases single-letter fallback tokens', () => {
    expect(tokenToLabel('a')).toBe('A');
  });
});

describe('parseShortcutTokens', () => {
  it('parses shortcut string into display tokens', () => {
    expect(parseShortcutTokens('CommandOrControl+Enter')).toEqual([IS_MAC ? '⌘' : 'Ctrl', '↵']);
  });

  it('ignores whitespace around tokens', () => {
    expect(parseShortcutTokens('  CommandOrControl + Enter  ')).toEqual([IS_MAC ? '⌘' : 'Ctrl', '↵']);
  });
});

describe('buildShortcutString', () => {
  it('builds shortcuts with modifiers and key', () => {
    expect(buildShortcutString(fakeEvent('Enter', { ctrlKey: true }))).toBe('CommandOrControl+Enter');
    expect(buildShortcutString(fakeEvent('S', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+S');
  });

  it('returns only modifiers when a modifier key is pressed', () => {
    expect(buildShortcutString(fakeEvent('Shift', { shiftKey: true }))).toBe('Shift');
  });
});

describe('normalizeShortcut', () => {
  it('normalizes case and whitespace for conflict comparison', () => {
    expect(normalizeShortcut('CommandOrControl + Enter')).toBe(normalizeShortcut('commandorcontrol+enter'));
  });
});
