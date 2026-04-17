// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKernelSubscriptions } from './useKernelSubscriptions';
import { useProjectWorkflow } from './useProjectWorkflow';

const noopUnsubscribe = () => {};

describe('PR #195 note tab clearing behavior', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'pdv', {
      configurable: true,
      value: {
        config: {
          set: vi.fn().mockResolvedValue({ recentProjects: ['/tmp/project'] }),
        },
        files: {
          pickDirectory: vi.fn(),
        },
        kernels: {
          onKernelCrashed: vi.fn(() => noopUnsubscribe),
          onOutput: vi.fn(() => noopUnsubscribe),
        },
        menu: {
          onAction: vi.fn(() => noopUnsubscribe),
          updateRecentProjects: vi.fn().mockResolvedValue(undefined),
        },
        modules: {
          removeImport: vi.fn().mockResolvedValue(undefined),
        },
        progress: {
          onProgress: vi.fn(() => noopUnsubscribe),
        },
        project: {
          load: vi.fn().mockResolvedValue({
            checksum: 'abcdef',
            checksumValid: true,
            codeCells: [{ id: 1, code: '' }],
            nodeCount: 1,
            projectName: 'Loaded Project',
            savedPdvVersion: '0.0.11',
          }),
          onLoaded: vi.fn(),
          onReloading: vi.fn(),
        },
        tree: {
          onChanged: vi.fn(() => noopUnsubscribe),
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('flushes dirty notes before clearing tabs on project reload ready', async () => {
    let onLoaded: (() => void) | undefined;
    let onReloading: ((payload: { status: 'reloading' | 'ready' }) => void) | undefined;

    window.pdv.project.onLoaded = vi.fn((callback: () => void) => {
      onLoaded = callback;
      return noopUnsubscribe;
    });
    window.pdv.project.onReloading = vi.fn((callback: (payload: { status: 'reloading' | 'ready' }) => void) => {
      onReloading = callback;
      return noopUnsubscribe;
    });

    const setNoteTabs = vi.fn();
    const setActiveNoteTabId = vi.fn();
    const setCellTabs = vi.fn();
    const setActiveCellTab = vi.fn();
    const setLogs = vi.fn();
    const setTreeRefreshToken = vi.fn();
    const setModulesRefreshToken = vi.fn();
    const setProjectReloading = vi.fn();
    const setProgress = vi.fn();
    const onKernelCrash = vi.fn();
    const onTreeChanged = vi.fn();
    const flushDirtyNotes = vi.fn(async () => {});

    renderHook(() =>
      useKernelSubscriptions({
        currentKernelId: 'kernel-1',
        flushDirtyNotes,
        loadedProjectTabsRef: { current: { tabs: [{ id: 4, code: 'x' }], activeTabId: 4 } },
        onKernelCrash,
        onTreeChanged,
        setActiveCellTab,
        setCellTabs,
        setLogs,
        setModulesRefreshToken,
        setNoteTabs,
        setActiveNoteTabId,
        setProgress,
        setProjectReloading,
        setTreeRefreshToken,
      }),
    );

    act(() => {
      onLoaded?.();
    });

    await act(async () => {
      onReloading?.({ status: 'ready' });
      await Promise.resolve();
    });

    expect(setCellTabs).toHaveBeenCalledWith([{ id: 4, code: 'x' }]);
    expect(setActiveCellTab).toHaveBeenCalledWith(4);
    expect(flushDirtyNotes).toHaveBeenCalledTimes(1);
    expect(setNoteTabs).toHaveBeenCalledWith([]);
    expect(setActiveNoteTabId).toHaveBeenCalledWith(null);
  });

  it('flushes dirty notes before executeOpenProject clears note tabs', async () => {
    const flushDirtyNotes = vi.fn(async () => {});
    const setNoteTabs = vi.fn();
    const setActiveNoteTabId = vi.fn();
    const setConfig = vi.fn();
    const setCurrentProjectDir = vi.fn();
    const setCellTabs = vi.fn();
    const setActiveCellTab = vi.fn();
    const setModulesRefreshToken = vi.fn();
    const setNamespaceRefreshToken = vi.fn();
    const setProgress = vi.fn();
    const setLastError = vi.fn();
    const setLogs = vi.fn();
    const setLastChecksum = vi.fn();
    const setChecksumMismatch = vi.fn();
    const setSavedPdvVersion = vi.fn();
    const setCurrentProjectName = vi.fn();
    const setShowSaveAsDialog = vi.fn();
    const normalizeLoadedCodeCells = vi.fn(() => ({
      tabs: [{ id: 1, code: '' }],
      activeTabId: 1,
    }));

    const { result } = renderHook(() =>
      useProjectWorkflow({
        kernelStatus: 'ready',
        currentProjectDir: null,
        cellTabs: [{ id: 1, code: '' }],
        activeCellTab: 1,
        config: { recentProjects: [] } as never,
        flushDirtyNotes,
        loadedProjectTabsRef: { current: null },
        normalizeLoadedCodeCells,
        setConfig,
        setCurrentProjectDir,
        setCellTabs,
        setActiveCellTab,
        setModulesRefreshToken,
        setNamespaceRefreshToken,
        setProgress,
        setLastError,
        setLogs,
        setLastChecksum,
        setChecksumMismatch,
        setSavedPdvVersion,
        setCurrentProjectName,
        setShowSaveAsDialog,
        setNoteTabs,
        setActiveNoteTabId,
      }),
    );

    await act(async () => {
      await result.current.executeOpenProject('/tmp/project');
    });

    expect(flushDirtyNotes).toHaveBeenCalledTimes(1);
    expect(setNoteTabs).toHaveBeenCalledWith([]);
    expect(setActiveNoteTabId).toHaveBeenCalledWith(null);
  });
});
