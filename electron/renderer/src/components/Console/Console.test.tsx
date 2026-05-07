// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../types';
import { Console } from './index';

afterEach(() => {
  cleanup();
});

vi.mock('./ansi', () => ({
  ansiToHtml: (value: string) => `<span>${value}</span>`,
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
});
