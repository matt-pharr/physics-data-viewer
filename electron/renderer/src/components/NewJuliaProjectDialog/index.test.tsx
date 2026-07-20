// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDVApi } from '../../types/pdv';
import { installPdvMock } from '../../test-fixtures/pdv-mock';
import { NewJuliaProjectDialog } from './index';

afterEach(() => {
  cleanup();
});

function renderDialog(overrides: {
  channels?: Awaited<ReturnType<PDVApi['environment']['juliaupChannels']>>;
  juliaupInstalled?: boolean;
  defaultPackages?: string[];
} = {}) {
  installPdvMock({
    environment: {
      juliaupChannels: vi.fn<PDVApi['environment']['juliaupChannels']>(
        async () => overrides.channels ?? [],
      ),
      juliaupStatus: vi.fn<PDVApi['environment']['juliaupStatus']>(async () => ({
        installed: overrides.juliaupInstalled ?? true,
        juliaupPath: overrides.juliaupInstalled === false ? null : '/x/juliaup',
      })),
    },
  });
  const handlers = { onCreate: vi.fn(), onCancel: vi.fn() };
  render(
    <NewJuliaProjectDialog
      defaultPackages={overrides.defaultPackages ?? []}
      {...handlers}
    />,
  );
  return handlers;
}

describe('NewJuliaProjectDialog', () => {
  it('renders the supported minors, marking installed channels and downloads', async () => {
    renderDialog({
      channels: [
        { channel: 'release', juliaPath: '/x/julia', version: '1.11.6', isDefault: true },
      ],
    });
    const select = screen.getByTestId('new-julia-project-version') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['1.10', '1.11', '1.12']);
    // The juliaup default channel's minor wins the preselection.
    await waitFor(() => expect(select.value).toBe('1.11'));
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[1]).toContain('installed (1.11.6)');
    expect(labels[0]).toContain('will be downloaded');
  });

  it('Create passes the chosen version and parsed packages', async () => {
    const { onCreate } = renderDialog();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('new-julia-project-version'), '1.10');
    await user.type(
      screen.getByTestId('new-julia-project-packages'),
      'DataFrames,  CSV@1.6 NPZ',
    );
    await user.click(screen.getByTestId('new-julia-project-create'));
    expect(onCreate).toHaveBeenCalledWith({
      juliaVersion: '1.10',
      packages: ['DataFrames', 'CSV@1.6', 'NPZ'],
    });
  });

  it('prefills Initial packages from defaultJuliaPackages and keeps edits', async () => {
    const { onCreate } = renderDialog({ defaultPackages: ['CairoMakie', 'HDF5'] });
    const packages = screen.getByTestId('new-julia-project-packages') as HTMLInputElement;
    expect(packages.value).toBe('CairoMakie, HDF5');
    // Entries are removable per project — clearing one must stick.
    const user = userEvent.setup();
    await user.clear(packages);
    await user.type(packages, 'HDF5');
    await user.click(screen.getByTestId('new-julia-project-create'));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ packages: ['HDF5'] }),
    );
  });

  it('without juliaup: no version select, and Create passes no version', async () => {
    const { onCreate } = renderDialog({ juliaupInstalled: false });
    await waitFor(() =>
      expect(screen.getByTestId('new-julia-project-no-juliaup')).toBeTruthy(),
    );
    expect(screen.queryByTestId('new-julia-project-version')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('new-julia-project-create'));
    expect(onCreate).toHaveBeenCalledWith({ juliaVersion: undefined, packages: [] });
  });

  it('Escape in the packages field cancels; Enter creates', async () => {
    const { onCancel, onCreate } = renderDialog();
    const user = userEvent.setup();
    const packages = screen.getByTestId('new-julia-project-packages');
    await user.click(packages);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(packages);
    await user.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
