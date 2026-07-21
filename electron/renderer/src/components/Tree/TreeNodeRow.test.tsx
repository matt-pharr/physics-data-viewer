// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNodeData } from '../../types';
import { TreeNodeRow } from './TreeNodeRow';

afterEach(() => {
  cleanup();
});

// Tests use arbitrary `type` strings to exercise icon fallback rendering;
// makeNode therefore accepts a wider type than TreeNodeData['type'].
function makeNode(overrides: Record<string, unknown> = {}): TreeNodeData & { depth: number } {
  return {
    id: 'data.x',
    key: 'x',
    path: 'data.x',
    type: 'folder',
    hasChildren: true,
    parentPath: 'data',
    depth: 0,
    isExpanded: false,
    isLoading: false,
    preview: 'preview',
    ...overrides,
  } as TreeNodeData & { depth: number };
}

// Icon rendering and pointer-event wiring (click/double-click/contextmenu) are
// covered end-to-end by `electron/e2e/tree-create-and-run.spec.ts`. The unit
// tests retained below pin the bits the E2E suite can't cheaply exercise:
// CSS class state and the loading-spinner/expanded-arrow markup.
describe('TreeNodeRow', () => {
  it('applies selected class and hidden expand button for leaf nodes', () => {
    const { container } = render(
      <TreeNodeRow
        node={makeNode({ hasChildren: false })}
        selected={true}
        onExpand={vi.fn()}
        onDoubleClick={vi.fn()}
        onRightClick={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(container.querySelector('.tree-row')?.className.includes('selected')).toBe(true);
    expect(container.querySelector('.tree-toggle')?.className.includes('hidden')).toBe(true);
  });

  it('renders loading spinner and expanded arrow states', () => {
    const { rerender } = render(
      <TreeNodeRow
        node={makeNode({ isLoading: true })}
        onExpand={vi.fn()}
        onDoubleClick={vi.fn()}
        onRightClick={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Loading children')).toBeTruthy();

    rerender(
      <TreeNodeRow
        node={makeNode({ isExpanded: true })}
        onExpand={vi.fn()}
        onDoubleClick={vi.fn()}
        onRightClick={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText('▼')).toBeTruthy();
  });

  it('labels the type chip by kind + language: Dict for Julia mappings, NamedTuple for NamedTuples', () => {
    const chipFor = (pythonType: string): string | null | undefined => {
      const { container } = render(
        <TreeNodeRow
          node={makeNode({ type: 'mapping', pythonType })}
          onExpand={vi.fn()}
          onDoubleClick={vi.fn()}
          onRightClick={vi.fn()}
          onClick={vi.fn()}
        />,
      );
      const text = container.querySelector('.tree-type-badge')?.textContent;
      cleanup();
      return text;
    };
    expect(chipFor('builtins.dict')).toBe('dict');
    expect(chipFor('Base.Dict{String, Any}')).toBe('Dict');
    expect(chipFor('Core.NamedTuple')).toBe('NamedTuple');
  });

  it('marks coordinate rows with a coord chip and muted row class', () => {
    const { container } = render(
      <TreeNodeRow
        node={makeNode({
          type: 'dataarray',
          hasChildren: false,
          isCoord: true,
        })}
        onExpand={vi.fn()}
        onDoubleClick={vi.fn()}
        onRightClick={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(container.querySelector('.tree-row')?.className.includes('coord')).toBe(true);
    expect(screen.getByText('coord')).toBeTruthy();
  });

  it('labels lazy data file nodes with format nouns', () => {
    const chipFor = (type: string): string | null | undefined => {
      const { container } = render(
        <TreeNodeRow
          node={makeNode({ type })}
          onExpand={vi.fn()}
          onDoubleClick={vi.fn()}
          onRightClick={vi.fn()}
          onClick={vi.fn()}
        />,
      );
      const text = container.querySelector('.tree-type-badge')?.textContent;
      cleanup();
      return text;
    };
    expect(chipFor('dataset_file')).toBe('netcdf');
    expect(chipFor('hdf5_file')).toBe('hdf5');
    expect(chipFor('hdf5_group')).toBe('group');
    expect(chipFor('hdf5_dataset')).toBe('h5.Dataset');
  });
});
