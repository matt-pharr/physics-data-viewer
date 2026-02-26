// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateScriptDialog } from './CreateScriptDialog';

afterEach(() => {
  cleanup();
});

describe('CreateScriptDialog', () => {
  it('renders parent path and initial disabled create button', () => {
    render(<CreateScriptDialog parentPath="scripts.analysis" onCreate={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('scripts.analysis')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sanitizes names and submits via Enter', async () => {
    const onCreate = vi.fn();
    render(<CreateScriptDialog parentPath="scripts" onCreate={onCreate} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText('my_script');
    await user.type(input, 'my script{enter}');

    expect(screen.getByText('Will create my_script.py inside the tree folder')).toBeTruthy();
    expect(onCreate).toHaveBeenCalledWith('my_script');
  });

  it('keeps create disabled for whitespace-only names', async () => {
    render(<CreateScriptDialog parentPath="" onCreate={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText('my_script');
    await user.type(input, '   ');
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onCancel for Escape and overlay click', async () => {
    const onCancel = vi.fn();
    render(<CreateScriptDialog parentPath="" onCreate={vi.fn()} onCancel={onCancel} />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText('my_script');
    await user.type(input, '{escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(document.querySelector('.modal-overlay') as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
