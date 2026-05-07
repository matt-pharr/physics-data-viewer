// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS } from '../../shortcuts';
import type { TreeNodeData } from '../../types';
import { ContextMenu } from './ContextMenu';

afterEach(() => {
  cleanup();
});

function node(type: string): TreeNodeData {
  return {
    id: 'data.x',
    key: 'x',
    path: 'data.x',
    type,
    hasChildren: false,
    parentPath: 'data',
  } as unknown as TreeNodeData;
}

// Action-set rendering, markdown variants, click → onAction/onClose wiring,
// and Escape/outside-click dismissal are exercised by the
// `tree-create-and-run.spec.ts` E2E flow. The unit tests retained below pin
// only the bits that are awkward to assert in a live window: the
// disabled-state contract for delete and the viewport-clamp math.
describe('ContextMenu', () => {
  it('shows enabled delete action and shortcut hints', () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        node={node('script')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const deleteButton = screen.getByRole('button', { name: /^Delete/ }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);
    expect(screen.getByText('E')).toBeTruthy();
    expect(screen.getByText('P')).toBeTruthy();
    expect(screen.getByText(/Ctrl\+C|⌘C/)).toBeTruthy();
  });

  it('clamps menu position to viewport bounds', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 220 });

    const { container } = render(
      <ContextMenu
        x={500}
        y={500}
        node={node('folder')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const menu = container.querySelector('.context-menu') as HTMLElement;
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('0px');
  });
});
