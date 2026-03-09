/**
 * Tests for the math delimiter scanner used by KaTeX inline previews.
 *
 * Validates that $...$ (inline) and $$...$$ (display) math regions are
 * correctly detected, including edge cases like escaped delimiters,
 * code blocks, empty math, and multiline display math.
 */

import { describe, expect, it } from 'vitest';
import { scanMathRegions } from './math-preview';

describe('scanMathRegions', () => {
  it('detects inline math with single dollar signs', () => {
    const regions = scanMathRegions('Hello $E=mc^2$ world');
    expect(regions).toHaveLength(1);
    expect(regions[0].latex).toBe('E=mc^2');
    expect(regions[0].displayMode).toBe(false);
    expect(regions[0].startLine).toBe(1);
    expect(regions[0].endLine).toBe(1);
  });

  it('detects display math with double dollar signs', () => {
    const regions = scanMathRegions('$$\\int_0^1 x dx$$');
    expect(regions).toHaveLength(1);
    expect(regions[0].latex).toBe('\\int_0^1 x dx');
    expect(regions[0].displayMode).toBe(true);
  });

  it('detects multiline display math', () => {
    const text = 'text\n$$\nx^2 + y^2 = r^2\n$$\nmore text';
    const regions = scanMathRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].displayMode).toBe(true);
    expect(regions[0].latex).toContain('x^2 + y^2 = r^2');
    expect(regions[0].startLine).toBe(2);
    expect(regions[0].endLine).toBe(4);
  });

  it('detects multiple inline math on the same line', () => {
    const regions = scanMathRegions('$a$ and $b$ and $c$');
    expect(regions).toHaveLength(3);
    expect(regions[0].latex).toBe('a');
    expect(regions[1].latex).toBe('b');
    expect(regions[2].latex).toBe('c');
  });

  it('ignores escaped dollar signs', () => {
    const regions = scanMathRegions('Price is \\$5 and \\$10');
    expect(regions).toHaveLength(0);
  });

  it('ignores math inside fenced code blocks', () => {
    const text = '```\n$E=mc^2$\n$$x^2$$\n```';
    const regions = scanMathRegions(text);
    expect(regions).toHaveLength(0);
  });

  it('ignores empty inline math ($$ with nothing)', () => {
    const regions = scanMathRegions('Empty $$ inline');
    // $$ at start is display math opening; no closing $$ → ignored
    // The point is: $$ is not treated as inline empty math
    expect(regions).toHaveLength(0);
  });

  it('handles mixed inline and display math', () => {
    const text = 'Inline $x$ then\n$$\ny = mx + b\n$$\nand $z$';
    const regions = scanMathRegions(text);
    expect(regions).toHaveLength(3);
    expect(regions[0].displayMode).toBe(false);
    expect(regions[0].latex).toBe('x');
    expect(regions[1].displayMode).toBe(true);
    expect(regions[1].latex).toContain('y = mx + b');
    expect(regions[2].displayMode).toBe(false);
    expect(regions[2].latex).toBe('z');
  });

  it('does not match across lines for inline math', () => {
    const text = '$start\nend$';
    const regions = scanMathRegions(text);
    expect(regions).toHaveLength(0);
  });

  it('handles escaped dollar inside math', () => {
    const regions = scanMathRegions('$cost = \\$5$');
    expect(regions).toHaveLength(1);
    expect(regions[0].latex).toBe('cost = \\$5');
  });

  it('returns empty array for text with no math', () => {
    const regions = scanMathRegions('Just plain text.\nNo math here.');
    expect(regions).toHaveLength(0);
  });

  it('handles display math on a single line', () => {
    const regions = scanMathRegions('$$x^2$$');
    expect(regions).toHaveLength(1);
    expect(regions[0].displayMode).toBe(true);
    expect(regions[0].latex).toBe('x^2');
  });

  it('handles code block fence with language tag', () => {
    const text = '```python\n$not_math$\n```\n$real_math$';
    const regions = scanMathRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].latex).toBe('real_math');
  });
});
