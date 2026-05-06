// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptParameter, ScriptRunResult } from '../../types';
import type { TreeNodeData } from '../../types';
import type { PDVApi } from '../../types/pdv';
import { installPdvMock, type PdvMock } from '../../test-fixtures/pdv-mock';
import { ScriptDialog } from './index';

function makeNode(overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: 'scripts.demo',
    key: 'demo',
    path: 'scripts.demo',
    type: 'script',
    hasChildren: false,
    parentPath: 'scripts',
    ...overrides,
  };
}

/** Set up window.pdv mock with getParams returning the given params. */
function setupPdvMock(params: ScriptParameter[] = []): PdvMock {
  return installPdvMock({
    script: {
      run: vi.fn<PDVApi['script']['run']>(async () => ({
        code: '',
        executionId: 'test-id',
        origin: { kind: 'tree-script' },
        result: {} as ScriptRunResult['result'],
      })),
      getParams: vi.fn<PDVApi['script']['getParams']>(async () => params),
    },
  });
}

afterEach(() => {
  cleanup();
});

// No-param render + cancel, end-to-end run-and-forward, kernel-error display,
// and the in-flight "Running..." state are reachable via the live tree-script
// run path covered by `tree-create-and-run.spec.ts`. The unit tests retained
// here pin the param-form rules that are easier to assert in isolation:
// required-param validation, input-type controls per type, and the boolean
// serialization contract sent to script.run.
describe('ScriptDialog', () => {
  it('requires required params before enabling run', async () => {
    setupPdvMock([{ name: 'name', type: 'str', required: true, default: null }]);
    render(<ScriptDialog node={makeNode()} kernelId="k1" onRun={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });
    const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);

    await user.type(screen.getByRole('textbox'), 'Alice');
    expect(runButton.disabled).toBe(false);
  });

  it('renders bool/int/float/string input controls', async () => {
    setupPdvMock([
      { name: 'flag', type: 'bool', required: false, default: false },
      { name: 'count', type: 'int', required: false, default: 1 },
      { name: 'ratio', type: 'float', required: false, default: 0.5 },
      { name: 'label', type: 'string', required: false, default: 'x' },
    ]);
    render(<ScriptDialog node={makeNode()} kernelId="k1" onRun={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox').length).toBe(1);
    });

    const numberInputs = screen.getAllByRole('spinbutton');
    expect(numberInputs.length).toBe(2);

    const textboxes = screen.getAllByRole('textbox');
    expect(textboxes.length).toBe(1);
  });

  it('serializes checkbox booleans in params', async () => {
    const pdv = setupPdvMock([{ name: 'flag', type: 'bool', required: false, default: false }]);
    const scriptRun = pdv.script.run;
    scriptRun.mockResolvedValue({
      code: '',
      executionId: 'exec-2',
      origin: { kind: 'tree-script', label: 'scripts.flags', scriptPath: 'scripts.flags' },
      result: { result: { done: true } },
    });
    const onRun = vi.fn();
    const node = makeNode({ path: 'scripts.flags' });
    render(<ScriptDialog node={node} kernelId="kernel-1" onRun={onRun} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeTruthy();
    });
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

});
