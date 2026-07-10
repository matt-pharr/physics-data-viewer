// @vitest-environment jsdom

/**
 * CreateTreeItemDialog tests — sanitizer contracts per kind plus the
 * whitespace-only disable check. Parent-path rendering, Enter-submit, and
 * Escape/overlay dismissal are covered by `tree-create-and-run.spec.ts`.
 *
 * The sanitizer cases pin the correctness fix that motivated unifying the
 * five Create*Dialog components: no kind may let `.` into a name, because
 * tree keys are dot-path segments and an embedded dot corrupts addressing.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateTreeItemDialog, sanitizeTreeItemName } from './CreateTreeItemDialog';

afterEach(() => {
  cleanup();
});

describe('sanitizeTreeItemName', () => {
  it('strips dots from every kind (dot-path corruption guard)', () => {
    for (const kind of ['node', 'script', 'note', 'gui', 'lib'] as const) {
      expect(sanitizeTreeItemName('a.b', kind)).not.toContain('.');
    }
  });

  it('replaces whitespace with underscores', () => {
    expect(sanitizeTreeItemName('my cool node', 'node')).toBe('my_cool_node');
  });

  it('strips the kind-specific extension before sanitizing', () => {
    expect(sanitizeTreeItemName('fit.py', 'script')).toBe('fit');
    expect(sanitizeTreeItemName('fit.jl', 'script')).toBe('fit');
    expect(sanitizeTreeItemName('readme.md', 'note')).toBe('readme');
    expect(sanitizeTreeItemName('dash.gui.json', 'gui')).toBe('dash');
    expect(sanitizeTreeItemName('helpers.py', 'lib')).toBe('helpers');
  });

  it('keeps hyphens for node/note/gui but not for script/lib', () => {
    expect(sanitizeTreeItemName('a-b', 'node')).toBe('a-b');
    expect(sanitizeTreeItemName('a-b', 'note')).toBe('a-b');
    expect(sanitizeTreeItemName('a-b', 'gui')).toBe('a-b');
    expect(sanitizeTreeItemName('a-b', 'script')).toBe('ab');
    expect(sanitizeTreeItemName('a-b', 'lib')).toBe('ab');
  });

  it('drops punctuation that previously leaked through the loose kinds', () => {
    expect(sanitizeTreeItemName('run(v2)!', 'script')).toBe('runv2');
    expect(sanitizeTreeItemName('notes: 2026', 'note')).toBe('notes_2026');
    expect(sanitizeTreeItemName('α.β', 'node')).toBe('');
  });
});

describe('CreateTreeItemDialog', () => {
  it('keeps create disabled for whitespace-only names', async () => {
    render(
      <CreateTreeItemDialog kind="script" parentPath="" onCreate={vi.fn()} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText('my_script');
    await user.type(input, '   ');
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('submits the sanitized name, not the raw one', async () => {
    const onCreate = vi.fn();
    render(
      <CreateTreeItemDialog kind="node" parentPath="data" onCreate={onCreate} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('my_node'), 'my run.v2');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith('my_runv2');
  });

  it('renders the kind-specific title and preview text', () => {
    render(
      <CreateTreeItemDialog kind="gui" parentPath="" onCreate={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText('Create new GUI')).toBeTruthy();
    expect(screen.getByText(/\.gui\.json in the tree folder/)).toBeTruthy();
  });
});
