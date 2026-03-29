// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptRunResult } from '../../types';
import type { TreeNodeData } from '../../types';
import { ScriptDialog } from './index';

type ScriptRunFn = (
  kernelId: string,
  request: {
    treePath: string;
    params: Record<string, string | number | boolean>;
    executionId: string;
    origin: {
      kind: 'code-cell' | 'tree-script' | 'unknown';
      label?: string;
      scriptPath?: string;
    };
  },
) => Promise<ScriptRunResult>;

function makeNode(overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: 'scripts.demo',
    key: 'demo',
    path: 'scripts.demo',
    parent_path: 'scripts',
    type: 'script',
    has_children: false,
    hasChildren: false,
    parentPath: 'scripts',
    params: [],
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'pdv', {
    configurable: true,
    value: {
      script: {
        run: vi.fn(async () => ({
          code: '',
          executionId: 'test-id',
          origin: { kind: 'tree-script' },
          result: {},
        })),
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('ScriptDialog', () => {
  it('renders no-parameter message and cancel behavior', async () => {
    const onCancel = vi.fn();
    render(<ScriptDialog node={makeNode()} kernelId="k1" onRun={vi.fn()} onCancel={onCancel} />);
    expect(screen.getByText('This script has no parameters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('requires required params before enabling run', async () => {
    const node = makeNode({
      params: [{ name: 'name', type: 'str', required: true, default: null }],
    });
    render(<ScriptDialog node={node} kernelId="k1" onRun={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);

    await user.type(screen.getByRole('textbox'), 'Alice');
    expect(runButton.disabled).toBe(false);
  });

  it('renders bool/int/float/string input controls', () => {
    const node = makeNode({
      params: [
        { name: 'flag', type: 'bool', required: false, default: false },
        { name: 'count', type: 'int', required: false, default: 1 },
        { name: 'ratio', type: 'float', required: false, default: 0.5 },
        { name: 'label', type: 'string', required: false, default: 'x' },
      ],
    });
    render(<ScriptDialog node={node} kernelId="k1" onRun={vi.fn()} onCancel={vi.fn()} />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(1);

    const numberInputs = screen.getAllByRole('spinbutton');
    expect(numberInputs.length).toBe(2);

    const textboxes = screen.getAllByRole('textbox');
    expect(textboxes.length).toBe(1);
  });

  it('calls script.run with correct payload and forwards result to onRun', async () => {
    const scriptRun = window.pdv.script.run as unknown as ReturnType<typeof vi.fn<ScriptRunFn>>;
    const mockResult: ScriptRunResult = {
      code: 'generated-code',
      executionId: 'exec-1',
      origin: { kind: 'tree-script', label: 'scripts.double', scriptPath: 'scripts.double' },
      result: { result: { done: true } },
    };
    scriptRun.mockResolvedValue(mockResult);
    const onRun = vi.fn();
    const node = makeNode({
      path: 'scripts.double',
      params: [{ name: 'x', type: 'int', required: true, default: null }],
    });
    render(<ScriptDialog node={node} kernelId="kernel-1" onRun={onRun} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('spinbutton'), '5');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(scriptRun).toHaveBeenCalledWith('kernel-1', expect.objectContaining({
        treePath: 'scripts.double',
        params: { x: 5 },
        origin: {
          kind: 'tree-script',
          label: 'scripts.double',
          scriptPath: 'scripts.double',
        },
      }));
    });
    expect(onRun).toHaveBeenCalledWith(mockResult);
  });

  it('serializes checkbox booleans in params', async () => {
    const scriptRun = window.pdv.script.run as unknown as ReturnType<typeof vi.fn<ScriptRunFn>>;
    scriptRun.mockResolvedValue({
      code: '',
      executionId: 'exec-2',
      origin: { kind: 'tree-script', label: 'scripts.flags', scriptPath: 'scripts.flags' },
      result: { result: { done: true } },
    });
    const onRun = vi.fn();
    const node = makeNode({
      path: 'scripts.flags',
      params: [{ name: 'flag', type: 'bool', required: false, default: false }],
    });
    render(<ScriptDialog node={node} kernelId="kernel-1" onRun={onRun} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(scriptRun).toHaveBeenCalledWith('kernel-1', expect.objectContaining({
        treePath: 'scripts.flags',
        params: { flag: true },
        origin: {
          kind: 'tree-script',
          label: 'scripts.flags',
          scriptPath: 'scripts.flags',
        },
      }));
    });
    expect(onRun).toHaveBeenCalled();
  });

  it('shows kernel error and does not call onRun', async () => {
    const scriptRun = window.pdv.script.run as unknown as ReturnType<typeof vi.fn<ScriptRunFn>>;
    scriptRun.mockRejectedValue(new Error('kernel failed'));
    const onRun = vi.fn();
    render(<ScriptDialog node={makeNode()} kernelId="k1" onRun={onRun} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(screen.getByText('kernel failed')).toBeTruthy();
    });
    expect(onRun).not.toHaveBeenCalled();
  });

  it('shows running state while execute is in flight', async () => {
    let resolveRun: ((value: ScriptRunResult) => void) | null = null;
    const scriptRun = window.pdv.script.run as unknown as ReturnType<typeof vi.fn<ScriptRunFn>>;
    scriptRun.mockImplementation(
      () =>
        new Promise<ScriptRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    render(<ScriptDialog node={makeNode()} kernelId="k1" onRun={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: 'Running...' })).toBeTruthy();
    resolveRun!({
      code: '',
      executionId: 'test',
      origin: { kind: 'tree-script' },
      result: {},
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
    });
  });
});
