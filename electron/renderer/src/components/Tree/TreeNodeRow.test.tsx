// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    parent_path: 'data',
    type: 'folder',
    has_children: true,
    hasChildren: true,
    parentPath: 'data',
    depth: 0,
    isExpanded: false,
    isLoading: false,
    preview: 'preview',
    ...overrides,
  } as TreeNodeData & { depth: number };
}

describe('TreeNodeRow', () => {
  it('renders known icons and fallback icon', () => {
    const onExpand = vi.fn();
    const onDoubleClick = vi.fn();
    const onRightClick = vi.fn();
    const onClick = vi.fn();

    const iconCases: Array<[string, string]> = [
      ['folder', '📁'], ['file', '📄'], ['script', '📜'], ['ndarray', '🔢'], ['dataframe', '📊'],
      ['series', '📈'], ['dict', '🗂️'], ['list', '🧾'], ['tuple', '🧾'], ['set', '🧾'],
      ['string', '🔤'], ['number', '#️⃣'], ['boolean', '✔️'], ['none', '∅'], ['image', '🖼️'],
      ['json', '{ }'], ['python', '🐍'], ['julia', '🔴'], ['unknown', '❓'],
    ];

    for (const [type, icon] of iconCases) {
      const { unmount } = render(
        <TreeNodeRow
          node={makeNode({ type, key: type })}
          onExpand={onExpand}
          onDoubleClick={onDoubleClick}
          onRightClick={onRightClick}
          onClick={onClick}
        />,
      );
      expect(screen.getByText(icon)).toBeTruthy();
      unmount();
    }

    render(
      <TreeNodeRow
        node={makeNode({ type: 'mystery', key: 'mystery' })}
        onExpand={onExpand}
        onDoubleClick={onDoubleClick}
        onRightClick={onRightClick}
        onClick={onClick}
      />,
    );
    expect(screen.getByText('❓')).toBeTruthy();
  });

  it('applies selected class and hidden expand button for leaf nodes', () => {
    const { container } = render(
      <TreeNodeRow
        node={makeNode({ hasChildren: false, has_children: false })}
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

  it('wires click, double click, right click, and expand interactions', () => {
    const onExpand = vi.fn();
    const onDoubleClick = vi.fn();
    const onRightClick = vi.fn();
    const onClick = vi.fn();

    const { container } = render(
      <TreeNodeRow
        node={makeNode({ depth: 2 })}
        onExpand={onExpand}
        onDoubleClick={onDoubleClick}
        onRightClick={onRightClick}
        onClick={onClick}
      />,
    );

    const row = container.querySelector('.tree-row') as HTMLElement;
    const toggle = screen.getByRole('button', { name: 'Expand x' });

    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(row);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(row);
    expect(onRightClick).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);

    const keyColumn = container.querySelector('.tree-col.key') as HTMLElement;
    expect(keyColumn.style.paddingLeft).toBe('calc(2 * var(--tree-indent-size))');
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
});
