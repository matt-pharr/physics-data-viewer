import AnsiToHtml from 'ansi-to-html';
import { describe, expect, it, vi } from 'vitest';
import { ansiToHtml, applyTerminalControls } from './ansi';

describe('applyTerminalControls', () => {
  it('passes plain text through unchanged', () => {
    expect(applyTerminalControls('hello')).toBe('hello');
  });

  it('handles carriage return overwrite', () => {
    expect(applyTerminalControls('hello\rworld')).toBe('world');
  });

  it('treats CRLF as a newline', () => {
    expect(applyTerminalControls('a\r\nb')).toBe('a\nb');
  });

  it('handles erase line CSI K', () => {
    expect(applyTerminalControls('abc\x1b[Kdone')).toBe('done');
  });

  it('handles cursor up CSI A', () => {
    expect(applyTerminalControls('line1\nline2\x1b[1Aover')).toBe('line1over\nline2');
  });

  it('handles cursor up-and-clear CSI F', () => {
    expect(applyTerminalControls('line1\nline2\x1b[1Fover')).toBe('over\nline2');
  });

  it('collapses pip-style progress updates to final line', () => {
    const input = 'progress 10%\rprogress 20%\x1b[2K\x1b[1A\x1b[2Kfinal';
    expect(applyTerminalControls(input)).toBe('final');
  });

  it('preserves ANSI style codes for color conversion pass', () => {
    expect(applyTerminalControls('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m');
  });

  it('strips lone escape bytes', () => {
    expect(applyTerminalControls('a\x1bb')).toBe('ab');
  });
});

describe('ansiToHtml', () => {
  it('converts color codes to HTML', () => {
    const html = ansiToHtml('\x1b[31mred\x1b[0m');
    expect(html).toContain('red');
    expect(html).toContain('<span');
  });

  it('falls back to escaped plain text when converter throws', () => {
    const spy = vi
      .spyOn((AnsiToHtml as unknown as { prototype: { toHtml: (value: string) => string } }).prototype, 'toHtml')
      .mockImplementation(() => {
        throw new Error('boom');
      });

    try {
      expect(ansiToHtml('<&>')).toBe('&lt;&amp;&gt;');
    } finally {
      spy.mockRestore();
    }
  });
});
