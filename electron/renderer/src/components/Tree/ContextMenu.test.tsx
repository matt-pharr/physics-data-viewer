// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('ContextMenu', () => {
  it('renders folder and script action sets', () => {
    const { rerender } = render(
      <ContextMenu
        x={10}
        y={10}
        node={node('folder')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Refresh/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Create new script/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Create new note/ })).toBeTruthy();

    rerender(
      <ContextMenu
        x={10}
        y={10}
        node={node('script')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Run\.\.\./ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Run defaults$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Edit/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Create new script/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Create new note/ })).toBeNull();
  });

  it('renders Open action for markdown nodes', () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        node={node('markdown')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Open.*Double-click/ })).toBeTruthy();
    // "Open in external editor" is disabled pending file-watcher support
    expect(screen.queryByRole('button', { name: /Open in external editor/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Create new script/ })).toBeNull();
  });

  it('calls onAction and onClose on menu click', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        node={node('script')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={onAction}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    expect(onAction).toHaveBeenCalledWith('edit', expect.objectContaining({ type: 'script' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('supports Escape and outside click close behavior', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        node={node('folder')}
        shortcuts={DEFAULT_SHORTCUTS}
        onAction={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

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
