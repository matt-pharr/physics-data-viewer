/**
 * Tests for the markdown-source preprocessor used by ReadView before handing
 * off to marked + marked-katex-extension. The cases encode the three behaviors
 * documented on normalizeMathDelimiters: trailing-whitespace stripping,
 * blank-line padding around standalone delimiter lines, and empty-math
 * escaping.
 */

import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from './ReadView';

describe('normalizeMathDelimiters', () => {
  describe('trailing whitespace on delimiter lines', () => {
    it('strips trailing spaces from a standalone $$ line', () => {
      expect(normalizeMathDelimiters('$$   \nx^2\n$$')).toBe('$$\n\nx^2\n\n$$');
    });

    it('strips trailing tabs from a standalone $ line', () => {
      expect(normalizeMathDelimiters('$\t\nfoo\n$')).toBe('$\n\nfoo\n\n$');
    });

    it('leaves non-delimiter lines with trailing whitespace alone', () => {
      const src = 'text   \n$$\nx\n$$';
      expect(normalizeMathDelimiters(src)).toBe('text   \n\n$$\n\nx\n\n$$');
    });
  });

  describe('blank-line padding around standalone $$ lines', () => {
    it('inserts a blank line before $$ when preceded by non-blank text', () => {
      expect(normalizeMathDelimiters('Formula:\n$$\nx^2\n$$'))
        .toBe('Formula:\n\n$$\n\nx^2\n\n$$');
    });

    it('inserts a blank line after $$ when followed by non-blank text', () => {
      expect(normalizeMathDelimiters('$$\nx^2\n$$\nAfter.'))
        .toBe('$$\n\nx^2\n\n$$\n\nAfter.');
    });

    it('does not insert blanks when they already exist', () => {
      const src = 'Formula:\n\n$$\n\nx^2\n\n$$\n\nAfter.';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('does not touch $$ embedded inline in a paragraph', () => {
      const src = 'here is $$a+b=c$$ inline.';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('does not break blockquote `>` continuity', () => {
      // $$ sits on a blockquote line (`> $$`) so it is NOT a top-level standalone
      // delimiter; no padding should be inserted.
      const src = [
        '> Before math.',
        '>',
        '> $$',
        '> x^2',
        '> $$',
        '>',
        '> After math.',
      ].join('\n');
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });

  describe('empty-math escaping', () => {
    it('escapes `$ $` to literal `\\$ \\$`', () => {
      expect(normalizeMathDelimiters('a $ $ b')).toBe('a \\$ \\$ b');
    });

    it('escapes `$$  $$` to literal `\\$\\$  \\$\\$`', () => {
      expect(normalizeMathDelimiters('a $$  $$ b')).toBe('a \\$\\$  \\$\\$ b');
    });

    it('leaves non-empty math untouched', () => {
      const src = 'real $x^2$ and $$a+b=c$$';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });

  describe('composition', () => {
    it('returns input unchanged when nothing needs normalizing', () => {
      const src = 'Plain prose with $x^2$ inline math.';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('handles empty input', () => {
      expect(normalizeMathDelimiters('')).toBe('');
    });

    it('handles the common `Label:\\n$$\\ncontent\\n$$\\ntail` pattern', () => {
      const src = 'Escaped inside display math:\n$$\n\\text{P}=\\$100\n$$\nafter.';
      const out = normalizeMathDelimiters(src);
      expect(out).toBe(
        'Escaped inside display math:\n\n$$\n\n\\text{P}=\\$100\n\n$$\n\nafter.'
      );
    });
  });
});
