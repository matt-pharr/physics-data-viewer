// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('Console', () => {
  it('renders empty state when no logs are present', () => {
    render(<Console logs={[]} onClear={vi.fn()} />);
    expect(screen.getByText('No output yet')).toBeTruthy();
  });

  it('renders log content for stdout/stderr/result/error/images/duration', () => {
    const log = makeLog({
      stdout: 'out',
      stderr: 'err',
      result: { x: 1 },
      error: 'boom',
      origin: { kind: 'code-cell', label: 'Tab 1', tabId: 1 },
      errorDetails: {
        name: 'ValueError',
        message: 'boom',
        summary: 'Code cell "Tab 1" (line 3, column 7): ValueError: boom',
        traceback: ['Traceback (most recent call last):', 'ValueError: boom'],
        location: { file: 'cell.py', line: 3, column: 7 },
        source: { kind: 'code-cell', label: 'Tab 1', tabId: 1 },
      },
      duration: 123.4,
      images: [{ mime: 'image/png', data: 'abcd' }],
    });
    const { container } = render(<Console logs={[log]} onClear={vi.fn()} />);

    expect(screen.getByText('[1]')).toBeTruthy();
    expect(screen.getByText('123ms')).toBeTruthy();
    expect(container.querySelector('.log-code')?.textContent).toContain('print("x")');
    expect(container.querySelector('.log-stdout')?.innerHTML).toContain('<span>out</span>');
    expect(container.querySelector('.log-stderr')?.innerHTML).toContain('<span>err</span>');
    expect(container.querySelector('.log-result')?.textContent).toContain('"x": 1');
    expect(screen.getByText('Error: boom')).toBeTruthy();
    expect(container.querySelector('.log-source')?.textContent).toBe('Cell 1');
    expect(screen.getByText('File cell.py, line 3, column 7')).toBeTruthy();
    expect(container.querySelector('.log-traceback')?.innerHTML).toContain('Traceback (most recent call last):');

    const image = screen.getByRole('img', { name: 'Plot 1.1' }) as HTMLImageElement;
    expect(image.src).toContain('data:image/png;base64,abcd');
  });

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

  it('wires clear/export actions and export visibility', () => {
    const onClear = vi.fn();
    const onExport = vi.fn();
    const { rerender } = render(<Console logs={[makeLog()]} onClear={onClear} />);
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();

    rerender(<Console logs={[makeLog()]} onClear={onClear} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
