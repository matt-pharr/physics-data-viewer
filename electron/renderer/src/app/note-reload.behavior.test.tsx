// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './index';

const readMock = vi.fn();
const noopUnsubscribe = () => {};

vi.mock('../components/CodeCell', () => ({
  CodeCell: () => <div data-testid="code-cell" />,
}));

vi.mock('../components/Console', () => ({
  Console: () => <div data-testid="console" />,
}));

vi.mock('../components/ActivityBar', () => ({
  ActivityBar: () => <div data-testid="activity-bar" />,
}));

vi.mock('../components/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));

vi.mock('../components/NamespaceView', () => ({
  NamespaceView: () => <div data-testid="namespace-view" />,
}));

vi.mock('../components/ScriptDialog', () => ({
  ScriptDialog: () => null,
}));

vi.mock('../components/Tree/CreateScriptDialog', () => ({
  CreateScriptDialog: () => null,
}));

vi.mock('../components/Tree/CreateLibDialog', () => ({
  CreateLibDialog: () => null,
}));

vi.mock('../components/Tree/CreateGuiDialog', () => ({
  CreateGuiDialog: () => null,
}));

vi.mock('../components/NewModuleDialog', () => ({
  NewModuleDialog: () => null,
}));

vi.mock('../components/ModuleMetadataDialog', () => ({
  ModuleMetadataDialog: () => null,
}));

vi.mock('../components/Tree/CreateNoteDialog', () => ({
  CreateNoteDialog: () => null,
}));

vi.mock('../components/TitleBar', () => ({
  TitleBar: () => null,
}));

vi.mock('../components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

vi.mock('../components/ImportModuleDialog', () => ({
  ImportModuleDialog: () => null,
}));

vi.mock('../components/SaveAsDialog', () => ({
  SaveAsDialog: () => null,
}));

vi.mock('../components/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('../components/WelcomeScreen', () => ({
  WelcomeScreen: () => null,
}));

vi.mock('../components/Tree', () => ({
  Tree: ({ onAction }: { onAction?: (action: string, node: { type: string; path: string; key: string }) => void }) => {
    const node = { type: 'markdown', path: 'notes.theory', key: 'theory' };
    return (
      <div>
        <button onClick={() => void onAction?.('open_note', node)}>open-note</button>
        <button onClick={() => void onAction?.('reload_note', node)}>reload-note</button>
        <button onClick={() => void onAction?.('refresh', node)}>refresh-tree</button>
      </div>
    );
  },
}));

vi.mock('../components/WriteTab', () => ({
  WriteTab: ({
    tabs,
    activeTabId,
    onContentChange,
  }: {
    tabs: Array<{ id: string; content: string }>;
    activeTabId: string | null;
    onContentChange: (id: string, content: string) => void;
  }) => {
    const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
    return (
      <div>
        <div data-testid="note-content">{active?.content ?? ''}</div>
        <button
          disabled={!active}
          onClick={() => {
            if (active) {
              onContentChange(active.id, 'unsaved local edit');
            }
          }}
        >
          edit-note
        </button>
      </div>
    );
  },
}));

vi.mock('./useLayoutState', () => ({
  useLayoutState: () => ({
    leftSidebarOpen: true,
    leftPanel: 'tree',
    editorCollapsed: false,
    leftWidth: 240,
    editorHeight: 320,
    rightPaneRef: { current: null },
    startVerticalDrag: vi.fn(),
    startHorizontalDrag: vi.fn(),
    handleActivityBarClick: vi.fn(),
    toggleLeftSidebar: vi.fn(),
    toggleEditorCollapsed: vi.fn(),
    collapseLeftSidebar: vi.fn(),
    expandEditor: vi.fn(),
  }),
}));

vi.mock('./useCodeCellsPersistence', () => ({
  useCodeCellsPersistence: () => {},
}));

vi.mock('./useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('./useKernelSubscriptions', () => ({
  useKernelSubscriptions: () => {},
}));

vi.mock('./useProjectWorkflow', () => ({
  useProjectWorkflow: () => ({
    handleSaveProject: vi.fn(async () => true),
    executeOpenProject: vi.fn(async () => {}),
  }),
}));

vi.mock('./useThemeManager', () => ({
  useThemeManager: () => 'vs-dark',
}));

vi.mock('../shortcuts', () => ({
  resolveShortcuts: () => ({}),
}));

vi.mock('./app-utils', () => ({
  normalizeLoadedCodeCells: () => ({ tabs: [{ id: 1, code: '' }], activeTabId: 1 }),
  normalizeRecentProjects: () => [],
  mergeConfigUpdate: (config: Record<string, unknown> | null, updates: Record<string, unknown>) => ({
    ...(config ?? {}),
    ...updates,
  }),
}));

vi.mock('./constants', () => ({
  CELL_UNDO_LIMIT: 20,
  MAX_LOG_ENTRIES: 500,
  NAMESPACE_REFRESH_INTERVAL_MS: 1000,
}));

vi.mock('./useKernelLifecycle', () => ({
  useKernelLifecycle: (options: {
    setCurrentKernelId: (kernelId: string) => void;
    setKernelStatus: (status: 'ready') => void;
  }) => {
    React.useEffect(() => {
      options.setCurrentKernelId('kernel-1');
      options.setKernelStatus('ready');
    }, [options]);
    return {
      startKernel: vi.fn(async () => true),
      handleEnvSave: vi.fn(async () => {}),
    };
  },
}));

describe('App note reload behavior in PR #195', () => {
  beforeEach(() => {
    readMock.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    Object.defineProperty(window, 'pdv', {
      configurable: true,
      value: {
        about: { getVersion: vi.fn().mockResolvedValue('0.0.11') },
        chrome: {
          getInfo: vi.fn().mockResolvedValue({ showCustomTitleBar: false, showMenuBar: false }),
          onStateChanged: vi.fn(() => noopUnsubscribe),
        },
        config: {
          get: vi.fn().mockResolvedValue({ recentProjects: [] }),
          set: vi.fn().mockResolvedValue({ recentProjects: [] }),
        },
        environment: { check: vi.fn() },
        files: { pickDirectory: vi.fn() },
        guiEditor: { open: vi.fn(), openViewer: vi.fn() },
        kernels: {
          onKernelCrashed: vi.fn(() => noopUnsubscribe),
          onOutput: vi.fn(() => noopUnsubscribe),
        },
        menu: {
          getModel: vi.fn().mockResolvedValue([]),
          onAction: vi.fn(() => noopUnsubscribe),
          updateEnabled: vi.fn(),
          updateRecentProjects: vi.fn(),
        },
        moduleWindows: {
          onExecuteRequest: vi.fn(() => noopUnsubscribe),
          open: vi.fn(),
        },
        modules: {
          exportFromProject: vi.fn(),
          listImported: vi.fn().mockResolvedValue([]),
          removeImport: vi.fn().mockResolvedValue(undefined),
        },
        note: {
          read: readMock,
          save: vi.fn(),
        },
        progress: {
          onProgress: vi.fn(() => noopUnsubscribe),
        },
        project: {
          load: vi.fn(),
          onLoaded: vi.fn(() => noopUnsubscribe),
          onReloading: vi.fn(() => noopUnsubscribe),
          peekManifest: vi.fn(),
          save: vi.fn(),
        },
        tree: {
          invokeHandler: vi.fn(),
          onChanged: vi.fn(() => noopUnsubscribe),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reload_note overwrites unsaved note content with the disk version', async () => {
    const confirmMock = vi.mocked(window.confirm);
    readMock
      .mockResolvedValueOnce({ success: true, content: 'disk version 1' })
      .mockResolvedValueOnce({ success: true, content: 'disk version 2' });

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'open-note' }));
    await waitFor(() => {
      expect(screen.getByTestId('note-content').textContent).toBe('disk version 1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'edit-note' }));
    expect(screen.getByTestId('note-content').textContent).toBe('unsaved local edit');

    fireEvent.click(screen.getByRole('button', { name: 'reload-note' }));
    await waitFor(() => {
      expect(screen.getByTestId('note-content').textContent).toBe('unsaved local edit');
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it('tree refresh skips dirty notes instead of overwriting them', async () => {
    readMock
      .mockResolvedValueOnce({ success: true, content: 'disk version 1' })
      .mockResolvedValueOnce({ success: true, content: 'disk version 2' });

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'open-note' }));
    await waitFor(() => {
      expect(screen.getByTestId('note-content').textContent).toBe('disk version 1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'edit-note' }));
    expect(screen.getByTestId('note-content').textContent).toBe('unsaved local edit');

    fireEvent.click(screen.getByRole('button', { name: 'refresh-tree' }));
    await waitFor(() => {
      expect(screen.getByTestId('note-content').textContent).toBe('unsaved local edit');
    });
    expect(readMock).toHaveBeenCalledTimes(1);
  });
});
