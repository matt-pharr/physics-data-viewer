// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamespaceInspectorNode, NamespaceVariable } from '../../types';
import type { PDVApi } from '../../types/pdv';
import { installPdvMock, type PdvMock } from '../../test-fixtures/pdv-mock';
import { NamespaceView } from './index';

function makeVars(): NamespaceVariable[] {
  return [
    {
      name: 'alpha',
      kind: 'scalar',
      type: 'int',
      size: 10,
      preview: '1',
      path: [],
      expression: 'alpha',
      hasChildren: false,
    },
    {
      name: 'arr',
      kind: 'ndarray',
      type: 'ndarray',
      preview: 'array([1, 2, 3])',
      path: [],
      expression: 'arr',
      hasChildren: true,
      childCount: 3,
      shape: [3],
    },
    {
      name: 'beta',
      kind: 'text',
      type: 'str',
      size: 5,
      preview: "'text'",
      path: [],
      expression: 'beta',
      hasChildren: false,
    },
  ];
}

function makeChildren(): NamespaceInspectorNode[] {
  return [
    {
      name: '[0]',
      kind: 'scalar',
      type: 'int64',
      preview: '1',
      path: [{ kind: 'index', value: 0 }],
      expression: 'arr[0]',
      hasChildren: false,
    },
  ];
}

let pdv: PdvMock;

beforeEach(() => {
  pdv = installPdvMock({
    namespace: {
      query: vi.fn<PDVApi['namespace']['query']>(async () => makeVars()),
      inspect: vi.fn<PDVApi['namespace']['inspect']>(async () => ({
        children: makeChildren(),
        truncated: false,
      })),
    },
  });
});

afterEach(() => {
  cleanup();
});

// Empty-kernel/disabled placeholder copy, search-filtering, error display,
// and lazy-expand are all covered indirectly when a real kernel runs against
// NamespaceView in the larger E2E flow. The unit tests retained here pin the
// mapping between UI controls and the request shape sent to
// `namespace.query`/`inspect`, plus the polling cadence — both of which are
// hard to verify with on/off-only observability.
describe('NamespaceView', () => {
  it('applies filter toggles to subsequent API requests', async () => {
    const query = pdv.namespace.query;
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

  it('sorts top-level rows by column header clicks and reacts to refreshToken changes', async () => {
    const query = pdv.namespace.query;
    const { rerender } = render(<NamespaceView kernelId="k1" refreshToken={0} />);
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Name/));
    const rows = document.querySelectorAll('.namespace-row');
    expect(rows[0]?.textContent).toContain('beta');

    rerender(<NamespaceView kernelId="k1" refreshToken={1} />);
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('auto-refresh triggers interval-based re-queries', async () => {
    const query = pdv.namespace.query;
    render(<NamespaceView kernelId="k1" autoRefresh refreshInterval={20} />);
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  });
});
