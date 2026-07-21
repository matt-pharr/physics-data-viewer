// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../types';
import { useStore } from '../../store';
import { Console } from './index';

beforeEach(() => {
  useStore.setState({ logs: [] });
});

afterEach(() => {
  cleanup();
});

const { ansiSpy } = vi.hoisted(() => ({
  ansiSpy: vi.fn((value: string) => `<span>${value}</span>`),
}));

vi.mock('./ansi', () => ({
  ansiToHtml: ansiSpy,
}));

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 'log-1',
    timestamp: Date.now(),
    code: 'print("x")',
    ...overrides,
  };
}

/** Seed the store's console slice and render the (store-subscribing) panel. */
function renderConsole(
  logs: LogEntry[],
  props: Partial<React.ComponentProps<typeof Console>> = {},
) {
  useStore.setState({ logs });
  return render(<Console onClear={props.onClear ?? vi.fn()} onInstallPackage={props.onInstallPackage} />);
}

// Empty-state rendering, stdout/stderr/result/image rendering, and the Clear
// button are exercised by `code-cell.spec.ts` (which actually drives stdout
// and result through a real kernel). The unit tests below pin the smaller
// formatting contracts that are awkward to produce live: the
// non-error-source-header layout and the literal-null result rendering.
describe('Console', () => {
  it('shows source in header without bottom context for non-error logs', () => {
    const { container } = renderConsole([
      makeLog({
        origin: { kind: 'code-cell', label: 'Tab 1', tabId: 1 },
        stdout: 'ok',
      }),
    ]);
    expect(container.querySelector('.log-source')?.textContent).toBe('Cell 1');
    expect(container.querySelector('.log-error-context')).toBeNull();
  });

  it('renders null result string', () => {
    const { container } = renderConsole([makeLog({ id: 'n', result: null })]);
    expect(container.querySelector('.log-result')?.textContent).toBe('null');
  });

  it('tags an agent-origin entry with the log-entry-agent modifier class', () => {
    const { container } = renderConsole([
      makeLog({
        id: 'agent-1',
        origin: { kind: 'agent', agentTool: 'pdv_run' },
      }),
    ]);
    const entry = container.querySelector('.log-entry');
    expect(entry).not.toBeNull();
    expect(entry?.classList.contains('log-entry-agent')).toBe(true);
    expect(container.querySelector('.log-source')?.textContent).toBe('Agent · pdv_run');
  });

  it('does not tag a code-cell entry with the agent class', () => {
    const { container } = renderConsole([
      makeLog({ id: 'cell-1', origin: { kind: 'code-cell', tabId: 2 } }),
    ]);
    const entry = container.querySelector('.log-entry');
    expect(entry?.classList.contains('log-entry-agent')).toBe(false);
  });

  const moduleNotFoundLog = (): LogEntry =>
    makeLog({
      error: "No module named 'xarray'",
      errorDetails: {
        name: 'ModuleNotFoundError',
        message: "No module named 'xarray'",
        summary: "No module named 'xarray'",
        traceback: [],
      },
    });

  it('offers pdv.install for a ModuleNotFoundError when onInstallPackage is provided', () => {
    const onInstallPackage = vi.fn();
    const { getByRole } = renderConsole([moduleNotFoundLog()], { onInstallPackage });
    const btn = getByRole('button', { name: /pdv\.install\("xarray"\)/ });
    btn.click();
    expect(onInstallPackage).toHaveBeenCalledWith('xarray');
  });

  it('hides the install affordance in shared mode (no onInstallPackage)', () => {
    const { container } = renderConsole([moduleNotFoundLog()]);
    expect(container.querySelector('.log-install-action')).toBeNull();
  });

  it('does not re-parse ANSI for entries whose object identity is unchanged', () => {
    const stable = makeLog({ id: 'stable', stdout: 'first entry output' });
    const growing = makeLog({ id: 'growing', stdout: 'chunk-1' });
    renderConsole([stable, growing]);
    ansiSpy.mockClear();

    // Streamed output replaces only the affected entry object (see
    // useKernelSubscriptions); the other entry keeps identity and its
    // memoized HTML.
    act(() => {
      useStore.setState({
        logs: [stable, { ...growing, stdout: growing.stdout + 'chunk-2' }],
      });
    });

    expect(ansiSpy).toHaveBeenCalledTimes(1);
    expect(ansiSpy).toHaveBeenCalledWith('chunk-1chunk-2');
  });
});
