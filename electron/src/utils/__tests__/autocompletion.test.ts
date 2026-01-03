/**
 * Unit tests for autocompletion utilities.
 */

import {
  getWordAtPosition,
  filterCompletions,
  getPythonKeywords,
  getPythonBuiltins,
} from '../autocompletion';

describe('autocompletion utils', () => {
  describe('getWordAtPosition', () => {
    it('should extract word at cursor position', () => {
      const result = getWordAtPosition('import numpy', 12);
      expect(result.word).toBe('numpy');
      expect(result.start).toBe(7);
    });

    it('should handle cursor at start', () => {
      const result = getWordAtPosition('test', 0);
      expect(result.word).toBe('');
      expect(result.start).toBe(0);
    });

    it('should handle cursor in middle of word', () => {
      const result = getWordAtPosition('variable', 4);
      expect(result.word).toBe('vari');
      expect(result.start).toBe(0);
    });

    it('should handle underscores in identifiers', () => {
      const result = getWordAtPosition('my_variable', 11);
      expect(result.word).toBe('my_variable');
      expect(result.start).toBe(0);
    });

    it('should handle special characters as word boundaries', () => {
      const result = getWordAtPosition('x + variable', 12);
      expect(result.word).toBe('variable');
      expect(result.start).toBe(4);
    });
  });

  describe('filterCompletions', () => {
    it('should filter completions by prefix', () => {
      const completions = ['apple', 'application', 'banana', 'apricot'];
      const filtered = filterCompletions(completions, 'app');
      expect(filtered).toEqual(['apple', 'application']);
    });

    it('should be case-insensitive', () => {
      const completions = ['Apple', 'BANANA', 'Apricot'];
      const filtered = filterCompletions(completions, 'ap');
      expect(filtered).toEqual(['Apple', 'Apricot']);
    });

    it('should return all completions for empty prefix', () => {
      const completions = ['apple', 'banana'];
      const filtered = filterCompletions(completions, '');
      expect(filtered).toEqual(completions);
    });

    it('should return empty array when no matches', () => {
      const completions = ['apple', 'banana'];
      const filtered = filterCompletions(completions, 'xyz');
      expect(filtered).toEqual([]);
    });
  });

  describe('getPythonKeywords', () => {
    it('should return Python keywords', () => {
      const keywords = getPythonKeywords();
      expect(keywords).toContain('import');
      expect(keywords).toContain('def');
      expect(keywords).toContain('class');
      expect(keywords).toContain('if');
      expect(keywords).toContain('for');
    });

    it('should include async/await keywords', () => {
      const keywords = getPythonKeywords();
      expect(keywords).toContain('async');
      expect(keywords).toContain('await');
    });

    it('should include boolean literals', () => {
      const keywords = getPythonKeywords();
      expect(keywords).toContain('True');
      expect(keywords).toContain('False');
      expect(keywords).toContain('None');
    });
  });

  describe('getPythonBuiltins', () => {
    it('should return Python builtins', () => {
      const builtins = getPythonBuiltins();
      expect(builtins).toContain('print');
      expect(builtins).toContain('len');
      expect(builtins).toContain('range');
      expect(builtins).toContain('str');
      expect(builtins).toContain('int');
    });

    it('should include common type constructors', () => {
      const builtins = getPythonBuiltins();
      expect(builtins).toContain('list');
      expect(builtins).toContain('dict');
      expect(builtins).toContain('set');
      expect(builtins).toContain('tuple');
    });

    it('should include common functions', () => {
      const builtins = getPythonBuiltins();
      expect(builtins).toContain('map');
      expect(builtins).toContain('filter');
      expect(builtins).toContain('enumerate');
      expect(builtins).toContain('zip');
    });
  });
});
