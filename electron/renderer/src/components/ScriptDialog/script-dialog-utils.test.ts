import { describe, expect, it } from 'vitest';
import type { ScriptParameter } from '../../types';
import { getParamKind, isValueProvided } from './index';

function requiredParam(name: string): ScriptParameter {
  return { name, type: 'any', default: null, required: true };
}

describe('getParamKind', () => {
  it('maps bool-like types to bool', () => {
    expect(getParamKind('bool')).toBe('bool');
    expect(getParamKind('Bool')).toBe('bool');
    expect(getParamKind('boolean')).toBe('bool');
  });

  it('maps int-like types to int', () => {
    expect(getParamKind('int')).toBe('int');
    expect(getParamKind('Int64')).toBe('int');
    expect(getParamKind('integer')).toBe('int');
  });

  it('maps float-like types to float', () => {
    expect(getParamKind('float')).toBe('float');
    expect(getParamKind('Float32')).toBe('float');
    expect(getParamKind('double float')).toBe('float');
  });

  it('falls back to string', () => {
    expect(getParamKind('str')).toBe('string');
    expect(getParamKind('path')).toBe('string');
    expect(getParamKind('')).toBe('string');
  });
});

describe('isValueProvided', () => {
  it('returns true for non-empty string values', () => {
    expect(isValueProvided(requiredParam('p'), { p: 'x' })).toBe(true);
  });

  it('returns false for empty/undefined/null strings', () => {
    expect(isValueProvided(requiredParam('p'), { p: '' })).toBe(false);
    expect(isValueProvided(requiredParam('p'), { p: '   ' })).toBe(false);
    expect(isValueProvided(requiredParam('p'), { p: undefined })).toBe(false);
    expect(isValueProvided(requiredParam('p'), { p: null })).toBe(false);
  });

  it('returns true for falsy non-string values', () => {
    expect(isValueProvided(requiredParam('p'), { p: 0 })).toBe(true);
    expect(isValueProvided(requiredParam('p'), { p: false })).toBe(true);
  });
});
