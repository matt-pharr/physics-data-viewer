// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS } from '../../shortcuts';

vi.mock('../../themes', () => ({
  defineMonacoThemes: vi.fn(),
}));

vi.mock('@monaco-editor/react', async () => {
  const ReactModule = await import('react');
  return {
    default: (props: {
      beforeMount?: (monaco: unknown) => void;
      onMount?: (editor: { onKeyDown: () => void }) => void;
    }) => {
      props.beforeMount?.((globalThis as { __testMonaco?: unknown }).__testMonaco);
      props.onMount?.({ onKeyDown: () => undefined });
      return ReactModule.createElement('div', { 'data-testid': 'mock-editor' });
    },
  };
});

type CompletionProvider = {
  triggerCharacters?: string[];
  provideCompletionItems: (
    model: MockModel,
    position: MockPosition,
    context?: { triggerCharacter?: string }
  ) => Promise<{
    suggestions: Array<{ label: string; insertText: string; kind: number }>;
  }>;
};

type MockPosition = { lineNumber: number; column: number };
type MockModel = {
  getValue: () => string;
  getOffsetAt: (position: MockPosition) => number;
  getPositionAt: (offset: number) => MockPosition;
};

let completionProvider: CompletionProvider | null = null;
const complete = vi.fn();
const inspect = vi.fn();
const treeList = vi.fn();
const registerCompletionItemProvider = vi.fn();

beforeEach(() => {
  completionProvider = null;
  complete.mockReset();
  inspect.mockReset();
  treeList.mockReset();
  registerCompletionItemProvider.mockReset();

  registerCompletionItemProvider.mockImplementation((_language: string, provider: CompletionProvider) => {
    completionProvider = provider;
    return { dispose: vi.fn() };
  });

  (globalThis as { __testMonaco?: unknown }).__testMonaco = {
    languages: {
      registerCompletionItemProvider,
      registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
      CompletionItemKind: {
        Function: 1,
        Module: 2,
        Class: 3,
        Keyword: 4,
        Property: 5,
        Snippet: 6,
        Variable: 7,
      },
    },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number
      ) {}
    },
  };

  Object.defineProperty(window, 'pdv', {
    configurable: true,
    value: {
      kernels: {
        complete,
        inspect,
      },
      tree: {
        list: treeList,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

function makeModel(code: string): MockModel {
  return {
    getValue: () => code,
    getOffsetAt: (position) => position.column - 1,
    getPositionAt: (offset) => ({ lineNumber: 1, column: offset + 1 }),
  };
}

async function renderCodeCell(kernelId: string | null): Promise<void> {
  const { CodeCell } = await import('./index');
  render(
    <CodeCell
      tabs={[{ id: 1, code: 'os.path.', onChange: vi.fn() }]}
      activeTabId={1}
      kernelId={kernelId}
      onTabChange={vi.fn()}
      onAddTab={vi.fn()}
      onRemoveTab={vi.fn()}
      onExecute={vi.fn()}
      onInterrupt={vi.fn()}
      onClear={vi.fn()}
      isExecuting={false}
      shortcuts={DEFAULT_SHORTCUTS}
    />
  );
}

describe('CodeCell completion provider', () => {
  it('registers the completion provider only once', async () => {
    await renderCodeCell('kernel-1');
    await renderCodeCell('kernel-1');
    expect(registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    const provider = registerCompletionItemProvider.mock.calls[0]?.[1] as CompletionProvider;
    expect(provider.triggerCharacters).toEqual(['.', '[', "'", '"']);
  });

  it('returns no suggestions when there is no active kernel', async () => {
    await renderCodeCell(null);
    expect(completionProvider).toBeTruthy();
    const result = await completionProvider!.provideCompletionItems(
      makeModel('os.path.'),
      { lineNumber: 1, column: 8 }
    );
    expect(result.suggestions).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('maps kernel completion results into Monaco suggestions', async () => {
    complete.mockResolvedValue({
      matches: ['join', 'exists'],
      cursor_start: 3,
      cursor_end: 8,
      metadata: {
        _jupyter_types_experimental: [{ text: 'join', type: 'function' }],
      },
    });
    await renderCodeCell('kernel-1');

    const result = await completionProvider!.provideCompletionItems(
      makeModel('os.path.'),
      { lineNumber: 1, column: 8 }
    );

    expect(complete).toHaveBeenCalledWith('kernel-1', 'os.path.', 7);
    expect(result.suggestions.map((s) => s.label)).toEqual(['join', 'exists']);
    expect(result.suggestions[0].insertText).toBe('join');
    expect(result.suggestions[0].kind).toBe(1);
    expect(result.suggestions[1].kind).toBe(7);
  });

  it('handles kernel completion failures gracefully', async () => {
    complete.mockRejectedValue(new Error('completion failed'));
    await renderCodeCell('kernel-1');

    const result = await completionProvider!.provideCompletionItems(
      makeModel('os.path.'),
      { lineNumber: 1, column: 8 }
    );

    expect(result.suggestions).toEqual([]);
  });

  it('adds pdv_tree fallback for pdv* prefix completions', async () => {
    complete.mockResolvedValue({
      matches: ['%pdb', 'pdv_kernel', 'pdv'],
      cursor_start: 0,
      cursor_end: 3,
    });
    await renderCodeCell('kernel-1');

    const result = await completionProvider!.provideCompletionItems(
      makeModel('pdv'),
      { lineNumber: 1, column: 4 }
    );

    expect(result.suggestions.map((s) => s.label)).toEqual(
      expect.arrayContaining(['pdv_tree', 'pdv', 'pdv_kernel', '%pdb'])
    );
  });

  it('returns no suggestions on quote trigger outside pdv_tree key context', async () => {
    await renderCodeCell('kernel-1');
    const result = await completionProvider!.provideCompletionItems(
      makeModel("'"),
      { lineNumber: 1, column: 2 },
      { triggerCharacter: "'" }
    );
    expect(result.suggestions).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(treeList).not.toHaveBeenCalled();
  });

  it('suggests tree paths inside pdv_tree key quotes', async () => {
    treeList.mockResolvedValue([
      { key: 'raw', path: 'data.raw' },
      { key: 'results', path: 'data.results' },
      { key: 'other', path: 'analysis.other' },
    ]);
    await renderCodeCell('kernel-1');

    const result = await completionProvider!.provideCompletionItems(
      makeModel("pdv_tree['data.r"),
      { lineNumber: 1, column: 17 },
      { triggerCharacter: "'" }
    );

    expect(treeList).toHaveBeenCalledWith('kernel-1', 'data');
    expect(complete).not.toHaveBeenCalled();
    expect(result.suggestions.map((s) => s.label)).toEqual(['data.raw', 'data.results']);
    expect(result.suggestions.map((s) => s.insertText)).toEqual(['data.raw', 'data.results']);
  });

  it('suggests valid child keys for chained pdv_tree bracket access', async () => {
    treeList.mockResolvedValue([
      { key: 'something', path: 'some.path.thatis.valid.something' },
      { key: 'somewhere', path: 'some.path.thatis.valid.somewhere' },
      { key: 'other', path: 'some.path.thatis.valid.other' },
    ]);
    await renderCodeCell('kernel-1');

    const code = "pdv_tree['some']['path']['thatis']['valid']['som";
    const result = await completionProvider!.provideCompletionItems(
      makeModel(code),
      { lineNumber: 1, column: code.length + 1 },
      { triggerCharacter: "'" }
    );

    expect(treeList).toHaveBeenCalledWith('kernel-1', 'some.path.thatis.valid');
    expect(complete).not.toHaveBeenCalled();
    expect(result.suggestions.map((s) => s.label)).toEqual([
      'some.path.thatis.valid.something',
      'some.path.thatis.valid.somewhere',
    ]);
    expect(result.suggestions.map((s) => s.insertText)).toEqual([
      'something',
      'somewhere',
    ]);
  });
});
