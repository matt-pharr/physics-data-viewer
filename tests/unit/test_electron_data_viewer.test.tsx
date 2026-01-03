import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TreeView } from '../../electron/src/components/DataViewer/TreeView';
import { VirtualScroller } from '../../electron/src/components/DataViewer/VirtualScroller';

describe('VirtualScroller', () => {
  it('computes visible ranges with overscan', () => {
    const scroller = new VirtualScroller(20, 5);
    expect(scroller.visibleRange(100, 0)).toEqual([0, 25]);
    expect(scroller.visibleRange(100, 10)).toEqual([5, 35]);
    expect(scroller.visibleRange(10, 9)).toEqual([4, 10]);
  });
});

describe('TreeView', () => {
  const sampleData = {
    numbers: Array.from({ length: 200 }, (_, idx) => idx),
    nested: { value: 1, deeper: { key: 'x' } },
  };

  it('renders a virtualized subset of nodes for large data', () => {
    render(<TreeView data={sampleData} viewportHeight={60} />);
    const nodes = screen.getAllByTestId('tree-node');
    expect(nodes.length).toBeLessThan(25);
  });

  it('triggers callbacks on double-click and context menu', () => {
    const onDouble = jest.fn();
    const onContext = jest.fn();
    render(<TreeView data={{ item: 1 }} viewportHeight={120} onNodeDoubleClick={onDouble} onContextMenu={onContext} />);
    const node = screen.getAllByTestId('tree-node')[0];
    fireEvent.doubleClick(node);
    expect(onDouble).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(node);
    expect(onContext).toHaveBeenCalledTimes(1);
  });
});
