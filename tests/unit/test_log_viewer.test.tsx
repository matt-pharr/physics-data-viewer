import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { LogViewer } from '../../electron/src/components/CommandLog/LogViewer';
import { LogSearch } from '../../electron/src/components/CommandLog/LogSearch';
import { LogEntry, buildLogExport } from '../../electron/src/utils/logFormatting';

const sampleEntries: LogEntry[] = [
  {
    id: 1,
    code: 'print("hello")',
    stdout: 'hello',
    timestamp: 0,
    durationMs: 12,
  },
  {
    id: 2,
    code: '1/0',
    stderr: 'ZeroDivisionError',
    error: 'division by zero',
    timestamp: 1000,
    durationMs: 5,
  },
];

describe('LogViewer', () => {
  it('renders log entries with metadata and output', () => {
    render(<LogViewer entries={sampleEntries} onClear={() => {}} onExport={() => {}} />);

    const entries = screen.getAllByTestId('log-entry');
    expect(entries).toHaveLength(2);
    expect(screen.getByText('print("hello")')).toBeInTheDocument();
    expect(screen.getByText(/Error:\s*division by zero/)).toBeInTheDocument();
    expect(screen.getByText(/ZeroDivisionError/)).toBeInTheDocument();
  });

  it('invokes export and clear handlers', () => {
    const onClear = jest.fn();
    const onExport = jest.fn();
    render(<LogViewer entries={sampleEntries} onClear={onClear} onExport={onExport} />);

    fireEvent.click(screen.getByText('Export'));
    fireEvent.click(screen.getByText('Clear Log'));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('LogSearch', () => {
  it('notifies when the query changes and resets', () => {
    const handleChange = jest.fn();
    const handleReset = jest.fn();
    render(
      <LogSearch
        query="error"
        total={5}
        filteredCount={2}
        onChange={handleChange}
        onReset={handleReset}
      />
    );

    const input = screen.getByLabelText('Search log');
    fireEvent.change(input, { target: { value: 'trace' } });
    expect(handleChange).toHaveBeenCalledWith('trace');

    fireEvent.click(screen.getByText('Clear Search'));
    expect(handleReset).toHaveBeenCalled();
    expect(screen.getByText('2 / 5 entries')).toBeInTheDocument();
  });
});

describe('logFormatting', () => {
  it('builds an export string containing code and output', () => {
    const exportText = buildLogExport(sampleEntries);
    expect(exportText).toContain('>>> print("hello")');
    expect(exportText).toContain('stderr: ZeroDivisionError');
    expect(exportText).toContain('error: division by zero');
  });
});
