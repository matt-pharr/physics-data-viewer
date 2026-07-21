// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamespaceInspectorNode, NamespaceVariable } from '../../types';
import type { PDVApi } from '../../types/pdv';
import { installPdvMock, type PdvMock } from '../../test-fixtures/pdv-mock';
import { queryClient } from '../../queries/client';
import { invalidateNamespace } from '../../queries/invalidation';
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

function renderNamespaceView(props: React.ComponentProps<typeof NamespaceView>) {
  const wrap = (p: React.ComponentProps<typeof NamespaceView>) => (
    <QueryClientProvider client={queryClient}>
      <NamespaceView {...p} />
    </QueryClientProvider>
  );
  const rendered = render(wrap(props));
  return {
    ...rendered,
    rerender: (nextProps: React.ComponentProps<typeof NamespaceView>) =>
      rendered.rerender(wrap(nextProps)),
  };
}

beforeEach(() => {
  queryClient.clear();
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
// `namespace.query`/`inspect`, plus the invalidation-driven refresh flow —
// both of which are hard to verify with on/off-only observability.
describe('NamespaceView', () => {
  it('applies filter toggles to subsequent API requests', async () => {
    const query = pdv.namespace.query;
    renderNamespaceView({ kernelId: 'k1' });
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

  it('sorts top-level rows by column header clicks and refetches on invalidation', async () => {
    const query = pdv.namespace.query;
    renderNamespaceView({ kernelId: 'k1' });
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Name/));
    const rows = document.querySelectorAll('.namespace-row');
    expect(rows[0]?.textContent).toContain('beta');

    invalidateNamespace('k1');
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('auto-refresh triggers interval-based re-queries', async () => {
    const query = pdv.namespace.query;
    renderNamespaceView({ kernelId: 'k1', autoRefresh: true, refreshInterval: 20 });
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  });

  it('keeps expanded nodes open (with refreshed children) across auto-refresh ticks', async () => {
    const query = pdv.namespace.query;
    const inspect = pdv.namespace.inspect;
    renderNamespaceView({ kernelId: 'k1', autoRefresh: true, refreshInterval: 20 });
    await waitFor(() => expect(screen.getByText('arr')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Expand arr/ }));
    await waitFor(() => expect(screen.getByText('[0]')).toBeTruthy());

    const queriesAtExpand = query.mock.calls.length;
    const inspectsAtExpand = inspect.mock.calls.length;
    // Let at least two refresh ticks land.
    await waitFor(
      () => expect(query.mock.calls.length).toBeGreaterThanOrEqual(queriesAtExpand + 2),
      { timeout: 2000 },
    );

    // Still expanded, and the refresh re-inspected the expanded node.
    expect(screen.getByText('[0]')).toBeTruthy();
    expect(inspect.mock.calls.length).toBeGreaterThan(inspectsAtExpand);
  });

  it('collapses an expanded node whose variable disappeared', async () => {
    const query = pdv.namespace.query;
    renderNamespaceView({ kernelId: 'k1', autoRefresh: true, refreshInterval: 20 });
    await waitFor(() => expect(screen.getByText('arr')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Expand arr/ }));
    await waitFor(() => expect(screen.getByText('[0]')).toBeTruthy());

    // The variable vanishes from the kernel: subsequent top-level queries no
    // longer include it, and inspecting it would fail.
    query.mockImplementation(async () => makeVars().filter((v) => v.name !== 'arr'));
    pdv.namespace.inspect.mockImplementation(async () => {
      throw new Error("name 'arr' is not defined");
    });

    // The next refresh tick drops the row and prunes the dead expansion.
    await waitFor(() => expect(screen.queryByText('arr')).toBeNull(), { timeout: 2000 });
    expect(screen.queryByText('[0]')).toBeNull();
    expect(document.querySelector('.namespace-message-error')).toBeNull();
  });
});
