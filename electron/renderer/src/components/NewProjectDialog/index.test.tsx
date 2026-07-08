// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentInfo, PDVApi } from '../../types/pdv';
import { installPdvMock } from '../../test-fixtures/pdv-mock';
import { NewProjectDialog } from './index';

afterEach(() => {
  cleanup();
});

function renderDialog(overrides: Partial<Parameters<typeof NewProjectDialog>[0]> = {}) {
  installPdvMock();
  const handlers = {
    onCreateUv: vi.fn(),
    onCreateShared: vi.fn(),
    onCancel: vi.fn(),
  };
  render(
    <NewProjectDialog
      defaultPackages={['numpy', 'matplotlib']}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('NewProjectDialog', () => {
  it('renders the supported versions with the default preselected and packages prefilled', () => {
    renderDialog();
    const select = screen.getByTestId('new-project-python-version') as HTMLSelectElement;
    expect(select.value).toBe('3.13');
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['3.10', '3.11', '3.12', '3.13', '3.14']);
    const packages = screen.getByTestId('new-project-packages') as HTMLInputElement;
    expect(packages.value).toBe('numpy, matplotlib');
  });

  it('Create passes the chosen version and parsed packages to onCreateUv', async () => {
    const { onCreateUv } = renderDialog();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('new-project-python-version'), '3.11');
    const packages = screen.getByTestId('new-project-packages');
    await user.clear(packages);
    await user.type(packages, 'scipy>=1.10,  xarray numpy');
    await user.click(screen.getByTestId('new-project-create'));
    expect(onCreateUv).toHaveBeenCalledWith({
      pythonVersion: '3.11',
      packages: ['scipy>=1.10', 'xarray', 'numpy'],
    });
  });

  it('an empty packages field creates with no packages', async () => {
    const { onCreateUv } = renderDialog();
    const user = userEvent.setup();
    await user.clear(screen.getByTestId('new-project-packages'));
    await user.click(screen.getByTestId('new-project-create'));
    expect(onCreateUv).toHaveBeenCalledWith({ pythonVersion: '3.13', packages: [] });
  });

  it('Escape in the packages field cancels; Enter creates', async () => {
    const { onCancel, onCreateUv } = renderDialog();
    const user = userEvent.setup();
    const packages = screen.getByTestId('new-project-packages');
    await user.click(packages);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(packages);
    await user.keyboard('{Enter}');
    expect(onCreateUv).toHaveBeenCalledTimes(1);
  });

  describe('existing-environment mode', () => {
    function installEnvListMock(env: Partial<EnvironmentInfo> = {}) {
      return installPdvMock({
        environment: {
          list: vi.fn<PDVApi['environment']['list']>(async () => [
            {
              kind: 'conda',
              pythonPath: '/opt/conda/envs/mpi/bin/python',
              label: 'conda: mpi (3.12.4)',
              pythonVersion: '3.12.4',
              pdvInstalled: true,
              pdvVersion: '0.2.0',
              pdvCompatible: true,
              pdvVersionMismatch: false,
              ipykernelInstalled: true,
              isFreeThreaded: false,
              ...env,
            } as EnvironmentInfo,
          ]),
          // Row clicks re-probe via check(); return null to keep the list info.
          check: vi.fn<PDVApi['environment']['check']>(async () => null),
        },
      });
    }

    function renderAdvanced() {
      const handlers = {
        onCreateUv: vi.fn(),
        onCreateShared: vi.fn(),
        onCancel: vi.fn(),
      };
      render(<NewProjectDialog defaultPackages={[]} {...handlers} />);
      return handlers;
    }

    it('opening Advanced hides the uv fields and disables Create until a selection exists', async () => {
      installEnvListMock();
      renderAdvanced();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('new-project-advanced-toggle'));
      // uv fields are gone — the two paths are mutually exclusive.
      expect(screen.queryByTestId('new-project-python-version')).toBeNull();
      expect(screen.queryByTestId('new-project-packages')).toBeNull();
      // The selector's own confirm button is suppressed; the footer Create
      // is the single confirm, disabled with no selection.
      expect(screen.queryByRole('button', { name: /select environment/i })).toBeNull();
      const create = screen.getByTestId('new-project-create') as HTMLButtonElement;
      expect(create.textContent).toMatch(/selected environment/i);
      expect(create.disabled).toBe(true);
    });

    it('Create confirms the selected usable environment via onCreateShared', async () => {
      installEnvListMock();
      const handlers = renderAdvanced();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('new-project-advanced-toggle'));
      await user.click(await screen.findByText(/conda: mpi/));
      const create = screen.getByTestId('new-project-create') as HTMLButtonElement;
      await waitFor(() => expect(create.disabled).toBe(false));
      await user.click(create);
      expect(handlers.onCreateShared).toHaveBeenCalledWith('/opt/conda/envs/mpi/bin/python');
      expect(handlers.onCreateUv).not.toHaveBeenCalled();
    });

    it('selecting an environment without pdv-python swaps the footer button to Install', async () => {
      installEnvListMock({ pdvInstalled: false, pdvVersion: null, pdvCompatible: false });
      const handlers = renderAdvanced();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('new-project-advanced-toggle'));
      await user.click(await screen.findByText(/conda: mpi/));
      // The required next step IS the footer button — no scrolling to a
      // buried inline install button, and no way to "Create" past it.
      await waitFor(() =>
        expect(screen.getByTestId('new-project-install-pdv')).toBeTruthy(),
      );
      expect(screen.queryByTestId('new-project-create')).toBeNull();
      // The selector's own inline install button is suppressed too — the
      // footer button is the only install affordance.
      expect(screen.queryByRole('button', { name: /^install pdv-python$/i })).toBe(
        screen.getByTestId('new-project-install-pdv'),
      );
      expect(handlers.onCreateShared).not.toHaveBeenCalled();
    });

    it('footer Install runs the install and flips to an enabled Create on success', async () => {
      const usableEnv = {
        kind: 'conda',
        pythonPath: '/opt/conda/envs/mpi/bin/python',
        label: 'conda: mpi (3.12.4)',
        pythonVersion: '3.12.4',
        pdvInstalled: true,
        pdvVersion: '0.2.0',
        pdvCompatible: true,
        pdvVersionMismatch: false,
        ipykernelInstalled: true,
        isFreeThreaded: false,
      } as EnvironmentInfo;
      installPdvMock({
        environment: {
          list: vi.fn<PDVApi['environment']['list']>(async () => [
            { ...usableEnv, pdvInstalled: false, pdvVersion: null, pdvCompatible: false },
          ]),
          // First check (row-click re-probe) still reports pdv missing; the
          // post-install re-probe reports it usable.
          check: vi
            .fn<PDVApi['environment']['check']>()
            .mockResolvedValueOnce({
              ...usableEnv,
              pdvInstalled: false,
              pdvVersion: null,
              pdvCompatible: false,
            })
            .mockResolvedValue(usableEnv),
          install: vi.fn<PDVApi['environment']['install']>(async () => ({
            success: true,
            output: 'installed',
          })),
        },
      });
      const handlers = {
        onCreateUv: vi.fn(),
        onCreateShared: vi.fn(),
        onCancel: vi.fn(),
      };
      render(<NewProjectDialog defaultPackages={[]} {...handlers} />);
      const user = userEvent.setup();
      await user.click(screen.getByTestId('new-project-advanced-toggle'));
      await user.click(await screen.findByText(/conda: mpi/));
      await user.click(await screen.findByTestId('new-project-install-pdv'));
      // Post-install re-probe flips the selection to usable → Create appears.
      const create = (await screen.findByTestId('new-project-create')) as HTMLButtonElement;
      expect(create.disabled).toBe(false);
      await user.click(create);
      expect(handlers.onCreateShared).toHaveBeenCalledWith('/opt/conda/envs/mpi/bin/python');
    });

    it('toggling back to uv mode restores the fields and the plain Create', async () => {
      installEnvListMock();
      const handlers = renderAdvanced();
      const user = userEvent.setup();
      const toggle = screen.getByTestId('new-project-advanced-toggle');
      await user.click(toggle);
      await user.click(toggle);
      expect(screen.getByTestId('new-project-python-version')).toBeTruthy();
      const create = screen.getByTestId('new-project-create') as HTMLButtonElement;
      expect(create.disabled).toBe(false);
      await user.click(create);
      expect(handlers.onCreateUv).toHaveBeenCalledTimes(1);
      expect(handlers.onCreateShared).not.toHaveBeenCalled();
    });
  });
});
