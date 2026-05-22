import { describe, expect, it } from 'vitest';
import {
  IS_MAC,
  buildShortcutString,
  checkForCommand,
  editorPresetIdForCommand,
  fileManagerPresetIdForCommand,
  getFileManagerPresets,
  getTerminalPresetsForPlatform,
  normalizeShortcut,
  parseShortcutTokens,
  terminalPresetCheck,
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

describe('terminal preset list', () => {
  it('offers a trimmed set on macOS (no Alacritty/WezTerm)', () => {
    expect(getTerminalPresetsForPlatform('darwin')).toEqual([
      'terminal-app', 'iterm2', 'kitty', 'ghostty', 'custom', 'none',
    ]);
  });
  it('keeps the full set on Linux', () => {
    expect(getTerminalPresetsForPlatform('linux')).toContain('alacritty');
    expect(getTerminalPresetsForPlatform('linux')).toContain('wezterm');
  });
});

describe('editorPresetIdForCommand', () => {
  it('reverse-maps a known editor command to its preset', () => {
    expect(editorPresetIdForCommand('code {}')).toBe('vscode');
    expect(editorPresetIdForCommand('nvim {}')).toBe('nvim');
  });
  it('returns "custom" for an unrecognised command', () => {
    expect(editorPresetIdForCommand('my-editor --wait {}')).toBe('custom');
    expect(editorPresetIdForCommand(undefined)).toBe('custom');
  });
});

describe('fileManagerPresetIdForCommand', () => {
  it('reverse-maps the platform default', () => {
    expect(fileManagerPresetIdForCommand('open {}', 'darwin')).toBe('finder');
    expect(fileManagerPresetIdForCommand('xdg-open {}', 'linux')).toBe('xdg-open');
  });
  it('returns "custom" for an unrecognised command', () => {
    expect(fileManagerPresetIdForCommand('ranger {}', 'linux')).toBe('custom');
  });
});

describe('getFileManagerPresets', () => {
  it('is platform-specific', () => {
    expect(getFileManagerPresets('darwin').map((p) => p.id)).toEqual(['finder']);
    expect(getFileManagerPresets('win32').map((p) => p.id)).toEqual(['explorer']);
    expect(getFileManagerPresets('linux').length).toBeGreaterThan(1);
  });
});

describe('checkForCommand', () => {
  it('derives a PATH check from the first token', () => {
    expect(checkForCommand('alacritty -e {cmd}')).toEqual({ kind: 'path', bin: 'alacritty' });
  });
  it('treats an empty command as always-available (no Save block)', () => {
    expect(checkForCommand('   ')).toEqual({ kind: 'none' });
  });
});

describe('terminalPresetCheck', () => {
  it('uses a macapp check for GUI terminals on macOS, PATH on Linux', () => {
    expect(terminalPresetCheck('ghostty', 'darwin')).toEqual({ kind: 'macapp', app: 'Ghostty' });
    expect(terminalPresetCheck('ghostty', 'linux')).toEqual({ kind: 'path', bin: 'ghostty' });
  });
  it('treats terminal-app and none as always-available', () => {
    expect(terminalPresetCheck('terminal-app', 'darwin')).toEqual({ kind: 'none' });
    expect(terminalPresetCheck('none', 'darwin')).toEqual({ kind: 'none' });
  });
  it('derives the custom check from the custom template', () => {
    expect(terminalPresetCheck('custom', 'linux', 'kitty -- {cmd}')).toEqual({
      kind: 'path', bin: 'kitty',
    });
  });
});
