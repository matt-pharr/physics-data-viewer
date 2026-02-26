// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamespaceVariable } from '../../types';
import { NamespaceView } from './index';

function makeVars(): NamespaceVariable[] {
  return [
    { name: 'alpha', type: 'int', size: 10, preview: '1' },
    { name: 'beta', type: 'str', size: 5, preview: 'text' },
  ];
}

beforeEach(() => {
  Object.defineProperty(window, 'pdv', {
    configurable: true,
    value: {
      namespace: {
        query: vi.fn(async () => makeVars()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('NamespaceView', () => {
  it('does not call API when kernel is null and shows empty kernel state', async () => {
    const query = window.pdv.namespace.query as unknown as ReturnType<typeof vi.fn>;
    render(<NamespaceView kernelId={null} />);
    await waitFor(() => {
      expect(screen.getByText('No kernel active')).toBeTruthy();
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('shows disabled state message when kernel is disabled', async () => {
    render(<NamespaceView kernelId="k1" disabled />);
    await waitFor(() => {
      expect(screen.getByText('Starting kernel...')).toBeTruthy();
    });
  });

  it('renders queried variables and supports search filtering', async () => {
    render(<NamespaceView kernelId="k1" />);
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeTruthy();
      expect(screen.getByText('beta')).toBeTruthy();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Search variables...'), 'alp');
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.queryByText('beta')).toBeNull();
  });

  it('shows error when API call fails', async () => {
    const query = window.pdv.namespace.query as unknown as ReturnType<typeof vi.fn>;
    query.mockRejectedValue(new Error('query failed'));
    render(<NamespaceView kernelId="k1" />);
    await waitFor(() => {
      expect(screen.getByText('query failed')).toBeTruthy();
    });
  });

  it('applies filter toggles to subsequent API requests', async () => {
    const query = window.pdv.namespace.query as unknown as ReturnType<typeof vi.fn>;
    render(<NamespaceView kernelId="k1" />);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('checkbox', { name: /Private/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Modules/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Functions/i }));

    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(4));
    const lastCall = query.mock.calls.at(-1) as [string, { includePrivate?: boolean; includeModules?: boolean; includeCallables?: boolean }];
    expect(lastCall[1]).toEqual(
      expect.objectContaining({
        includePrivate: true,
        includeModules: true,
        includeCallables: true,
      }),
    );
  });

  it('sorts by column header clicks and reacts to refreshToken changes', async () => {
    const query = window.pdv.namespace.query as unknown as ReturnType<typeof vi.fn>;
    const { rerender } = render(<NamespaceView kernelId="k1" refreshToken={0} />);
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Name/));
    const rows = document.querySelectorAll('.namespace-row');
    expect(rows[0].textContent).toContain('beta');

    rerender(<NamespaceView kernelId="k1" refreshToken={1} />);
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('auto-refresh triggers interval-based re-queries', async () => {
    const query = window.pdv.namespace.query as unknown as ReturnType<typeof vi.fn>;
    render(<NamespaceView kernelId="k1" autoRefresh refreshInterval={20} />);
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  });
});
