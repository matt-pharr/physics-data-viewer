// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateScriptDialog } from './CreateScriptDialog';

afterEach(() => {
  cleanup();
});

// Parent-path rendering, name sanitization on Enter, and Escape/overlay
// dismissal are covered by `tree-create-and-run.spec.ts`. The whitespace-only
// disable check is the only behavior that the E2E spec doesn't naturally hit
// (the user there always types a real name), so it stays as a unit test.
describe('CreateScriptDialog', () => {
  it('keeps create disabled for whitespace-only names', async () => {
    render(<CreateScriptDialog parentPath="" onCreate={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText('my_script');
    await user.type(input, '   ');
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
