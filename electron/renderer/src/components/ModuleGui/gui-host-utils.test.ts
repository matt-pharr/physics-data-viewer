// @vitest-environment jsdom

/**
 * gui-host-utils tests — the shared GUI-host glue.
 *
 * resolveTreeDropdownOptions pins the GuiViewerRoot fix: dropdowns bound to
 * an `optionsTreePath` must populate from the tree (the viewer previously
 * skipped resolution and rendered them empty).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor, PDVApi } from '../../types/pdv';
import { installPdvMock } from '../../test-fixtures/pdv-mock';
import { adaptGuiActions, resolveTreeDropdownOptions } from './gui-host-utils';
import type { ModuleInputDescriptor } from '../ModulesPanel/moduleUiHelpers';

const children: NodeDescriptor[] = [
  { id: 'runs.a', key: 'a', path: 'runs.a', parent_path: 'runs', type: 'folder', has_children: false },
  { id: 'runs.b', key: 'b', path: 'runs.b', parent_path: 'runs', type: 'folder', has_children: false },
];

describe('adaptGuiActions', () => {
  it('maps manifest actions to the ContainerRenderer shape', () => {
    expect(
      adaptGuiActions([{ id: 'fit', label: 'Fit', script_path: 'scripts/fit.py', inputs: ['x'] }]),
    ).toEqual([{ id: 'fit', label: 'Fit', scriptName: 'scripts/fit.py', inputIds: ['x'] }]);
  });
});

describe('resolveTreeDropdownOptions', () => {
  beforeEach(() => {
    installPdvMock({
      tree: {
        list: vi.fn<PDVApi['tree']['list']>(async (_kernelId, path) =>
          path === 'runs' ? children : [],
        ),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('populates options for dropdowns bound to a tree path', async () => {
    const inputs: ModuleInputDescriptor[] = [
      { id: 'run', label: 'Run', control: 'dropdown', optionsTreePath: 'runs' },
      { id: 'name', label: 'Name', control: 'text' },
    ];

    const resolved = await resolveTreeDropdownOptions(inputs, 'k1');

    expect(resolved[0].options).toEqual([
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b' },
    ]);
    // Unbound inputs pass through untouched (same reference).
    expect(resolved[1]).toBe(inputs[1]);
  });

  it('resolves a blank bound path to an empty option list', async () => {
    const inputs: ModuleInputDescriptor[] = [
      { id: 'run', label: 'Run', control: 'dropdown', optionsTreePath: '  ' },
    ];
    const resolved = await resolveTreeDropdownOptions(inputs, 'k1');
    expect(resolved[0].options).toEqual([]);
  });

  it('leaves static dropdown options alone', async () => {
    const input: ModuleInputDescriptor = {
      id: 'mode',
      label: 'Mode',
      control: 'dropdown',
      options: [{ label: 'Fast', value: 'fast' }],
    };
    const resolved = await resolveTreeDropdownOptions([input], 'k1');
    expect(resolved[0]).toBe(input);
  });
});
