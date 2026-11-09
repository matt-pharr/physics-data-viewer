/**
 * path.test.ts — Tests for the separator-aware renderer path helpers.
 */

import { describe, expect, it } from 'vitest';

import { baseName, dirName, joinPath, pathSeparatorFor } from './path';

describe('pathSeparatorFor', () => {
  it('detects Windows drive-letter and UNC paths', () => {
    expect(pathSeparatorFor('C:\\Users\\me')).toBe('\\');
    expect(pathSeparatorFor('c:/Users/me')).toBe('\\');
    expect(pathSeparatorFor('\\\\server\\share')).toBe('\\');
  });

  it('treats everything else as POSIX', () => {
    expect(pathSeparatorFor('/home/me')).toBe('/');
    expect(pathSeparatorFor('relative/dir')).toBe('/');
  });
});

describe('joinPath', () => {
  it('joins with the directory\'s own separator', () => {
    expect(joinPath('C:\\Users\\me\\PDV_projects', 'test')).toBe('C:\\Users\\me\\PDV_projects\\test');
    expect(joinPath('/home/me/PDV_projects', 'test')).toBe('/home/me/PDV_projects/test');
  });

  it('does not double a trailing separator', () => {
    expect(joinPath('C:\\', 'test')).toBe('C:\\test');
    expect(joinPath('/', 'test')).toBe('/test');
  });
});

describe('baseName / dirName', () => {
  it('handle Windows paths', () => {
    expect(baseName('C:\\Users\\me\\proj')).toBe('proj');
    expect(dirName('C:\\Users\\me\\proj')).toBe('C:\\Users\\me');
    expect(dirName('C:\\proj')).toBe('C:\\');
  });

  it('stop at a UNC share root', () => {
    expect(dirName('\\\\server\\share\\proj')).toBe('\\\\server\\share');
    expect(dirName('\\\\server\\share')).toBe('\\\\server\\share');
    expect(baseName('\\\\server\\share\\proj')).toBe('proj');
  });

  it('handle POSIX paths', () => {
    expect(baseName('/home/me/proj/')).toBe('proj');
    expect(dirName('/home/me/proj')).toBe('/home/me');
    expect(dirName('/proj')).toBe('/');
  });
});
