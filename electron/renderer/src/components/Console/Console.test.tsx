// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../types';
import { Console } from './index';

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

// Empty-state rendering, stdout/stderr/result/image rendering, and the Clear
// button are exercised by `code-cell.spec.ts` (which actually drives stdout
// and result through a real kernel). The unit tests below pin the smaller
// formatting contracts that are awkward to produce live: the
// non-error-source-header layout and the literal-null result rendering.
describe('Console', () => {
  it('shows source in header without bottom context for non-error logs', () => {
    const { container } = render(
      <Console
        logs={[
          makeLog({
            origin: { kind: 'code-cell', label: 'Tab 1', tabId: 1 },
            stdout: 'ok',
          }),
        ]}
        onClear={vi.fn()}
      />
    );
    expect(container.querySelector('.log-source')?.textContent).toBe('Cell 1');
    expect(container.querySelector('.log-error-context')).toBeNull();
  });

  it('renders null result string', () => {
    const { container } = render(<Console logs={[makeLog({ id: 'n', result: null })]} onClear={vi.fn()} />);
    expect(container.querySelector('.log-result')?.textContent).toBe('null');
  });

  it('tags an agent-origin entry with the log-entry-agent modifier class', () => {
    const { container } = render(
      <Console
        logs={[
          makeLog({
            id: 'agent-1',
            origin: { kind: 'agent', agentTool: 'pdv_run' },
          }),
        ]}
        onClear={vi.fn()}
      />
    );
    const entry = container.querySelector('.log-entry');
    expect(entry).not.toBeNull();
    expect(entry?.classList.contains('log-entry-agent')).toBe(true);
    expect(container.querySelector('.log-source')?.textContent).toBe('Agent · pdv_run');
  });

  it('does not tag a code-cell entry with the agent class', () => {
    const { container } = render(
      <Console
        logs={[makeLog({ id: 'cell-1', origin: { kind: 'code-cell', tabId: 2 } })]}
        onClear={vi.fn()}
      />
    );
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
    const { getByRole } = render(
      <Console logs={[moduleNotFoundLog()]} onClear={vi.fn()} onInstallPackage={onInstallPackage} />
    );
    const btn = getByRole('button', { name: /pdv\.install\("xarray"\)/ });
    btn.click();
    expect(onInstallPackage).toHaveBeenCalledWith('xarray');
  });

  it('hides the install affordance in shared mode (no onInstallPackage)', () => {
    const { container } = render(<Console logs={[moduleNotFoundLog()]} onClear={vi.fn()} />);
    expect(container.querySelector('.log-install-action')).toBeNull();
  });

  it('does not re-parse ANSI for entries whose object identity is unchanged', () => {
    const stable = makeLog({ id: 'stable', stdout: 'first entry output' });
    const growing = makeLog({ id: 'growing', stdout: 'chunk-1' });
    const onClear = vi.fn();
    const { rerender } = render(<Console logs={[stable, growing]} onClear={onClear} />);
    ansiSpy.mockClear();

    // Streamed output replaces only the affected entry object (see
    // useKernelSubscriptions); the other entry keeps identity and its
    // memoized HTML.
    rerender(
      <Console
        logs={[stable, { ...growing, stdout: growing.stdout + 'chunk-2' }]}
        onClear={onClear}
      />
    );

    expect(ansiSpy).toHaveBeenCalledTimes(1);
    expect(ansiSpy).toHaveBeenCalledWith('chunk-1chunk-2');
  });
});
