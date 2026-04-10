# App Hooks — Composition and Data Flow

The root `App` component (`app/index.tsx`) orchestrates all application state via 7 custom hooks. This document explains each hook's purpose, what state it owns or consumes, and how the hooks relate to each other.

## Architecture Overview

```
App (index.tsx)
 ├── 21 useState declarations (grouped by domain — see §State Groups below)
 ├── useLayoutState()           — sidebar/pane geometry (localStorage)
 ├── useThemeManager()          — theme colors + Monaco theme
 ├── useCodeCellsPersistence()  — load/save code tabs to ~/.PDV/state/
 ├── useKernelSubscriptions()   — push-subscription lifecycle
 ├── useKernelLifecycle()       — start / restart / env-save
 ├── useKeyboardShortcuts()     — global keydown listener
 └── useProjectWorkflow()       — save / load / new project
```

Hooks never call each other directly. They communicate through **shared state**: each hook receives the App-level `useState` values and setters it needs via an options object, and returns callbacks or derived values consumed by App or its children.

---

## State Groups

App's 21 `useState` calls are organized into these logical groups:

| Group | States | Primary Consumers |
|-------|--------|--------------------|
| **Code editor** | `cellTabs`, `activeCellTab` | CodeCell, useCodeCellsPersistence, useKeyboardShortcuts, useProjectWorkflow |
| **Console** | `logs` | Console, useKernelSubscriptions, useKernelLifecycle |
| **Kernel** | `currentKernelId`, `kernelStatus`, `isExecuting`, `lastError`, `codeCellExecutionError`, `lastDuration` | useKernelLifecycle, useKernelSubscriptions, CodeCell, Tree, status bar |
| **Config** | `config` | useThemeManager, useKernelLifecycle, useProjectWorkflow, CodeCell, ModulesPanel |
| **Project** | `currentProjectDir` | useProjectWorkflow, title bar |
| **Refresh tokens** | `treeRefreshToken`, `namespaceRefreshToken`, `modulesRefreshToken`, `autoRefreshNamespace` | Tree, NamespaceView, ModulesPanel |
| **Dialogs** | `showEnvSelector`, `scriptDialog`, `createScriptTarget`, `showSettings`, `settingsInitialTab` | EnvironmentSelector, ScriptDialog, CreateScriptDialog, SettingsDialog |

### Refresh Token Pattern

Several hooks bump integer "refresh tokens" (e.g. `setTreeRefreshToken(t => t + 1)`) to signal child components that they should refetch data. This avoids passing full data objects through the component tree — children own their own fetch logic and simply re-run it when their token prop changes.

---

## Hook Reference

### `useLayoutState()`

**Purpose**: Manages sidebar visibility, panel selection, and pane dimensions with localStorage persistence.

**Takes**: Nothing (reads localStorage directly).

**Returns**: Layout state values (`leftSidebarOpen`, `leftPanel`, `rightSidebarOpen`, `editorCollapsed`, `leftWidth`, `rightWidth`, `editorHeight`, `rightPaneRef`) and handler functions (`startVerticalDrag`, `handleActivityBarClick`, `toggleLeftSidebar`, `toggleEditorCollapsed`, `collapseLeftSidebar`, `collapseRightSidebar`, `expandEditor`).

**Dependencies**: None — fully independent.

---

### `useThemeManager({ config })`

**Purpose**: Applies theme colors to CSS custom properties and tracks system `prefers-color-scheme` changes.

**Takes**: `config` (for `settings.appearance` and `settings.fonts`).

**Returns**: `monacoTheme` (string) — the Monaco editor theme name passed to CodeCell.

**Side effects**: Calls `applyThemeColors()` and `applyFontSettings()` whenever config or system preference changes.

**Dependencies**: None — reads config only.

---

### `useCodeCellsPersistence({ cellTabs, activeCellTab, setCellTabs, setActiveCellTab })`

**Purpose**: Loads persisted code cell tabs from `~/.PDV/state/code-cells.json` on mount and saves them back on every change (debounced by `CODE_CELL_SAVE_DEBOUNCE_MS`).

**Takes**: Code editor state and setters.

**Returns**: Nothing (void).

**Dependencies**: None — independent read/write to filesystem.

---

### `useKernelSubscriptions({ currentKernelId, loadedProjectTabsRef, ... })`

**Purpose**: Registers and tears down three push subscriptions keyed on `currentKernelId`:
- `window.pdv.kernels.onOutput()` → appends stdout/stderr/images to console logs
- `window.pdv.tree.onChanged()` → bumps tree and modules refresh tokens
- `window.pdv.project.onLoaded()` → restores code cell tabs from project snapshot

**Takes**: `currentKernelId`, `loadedProjectTabsRef`, and setters for logs, cellTabs, activeCellTab, treeRefreshToken, modulesRefreshToken.

**Returns**: Nothing (void). Subscriptions are cleaned up on kernel change or unmount.

**Re-registration**: When `currentKernelId` changes, all subscriptions are torn down and re-registered for the new kernel.

---

### `useKernelLifecycle({ config, currentKernelId, ... })`

**Purpose**: Provides callbacks for starting, restarting, and reconfiguring the kernel.

**Takes**: Config, current kernel ID, and setters for kernel status, error state, env selector visibility, logs, and refresh tokens.

**Returns**:
- `startKernel(cfg)` — stops any existing kernel, starts a new one with the given config
- `handleEnvSave(paths)` — saves new environment paths to config and calls `startKernel`
- `handleRestartKernel()` — restarts the current kernel (clears logs, bumps refresh tokens)

**Dependencies**: Uses `currentKernelId` to know which kernel to stop/restart.

---

### `useKeyboardShortcuts({ shortcuts, cellTabs, activeCellTab, ... })`

**Purpose**: Registers a global `keydown` listener for all application keyboard shortcuts.

**Handles**:
- `Cmd+Z` (outside Monaco) — undo last cell clear/close from undo stack
- `Cmd+1–9` / `Cmd+0` — switch to nth tab / last tab
- Configurable shortcuts — new tab, close tab, open settings, close window
- `Cmd+B` — toggle left sidebar
- `Cmd+J` — toggle code editor

**Takes**: Shortcut bindings, cell state (via internal refs to avoid re-registration), layout toggle callbacks, and tab management callbacks.

**Returns**: Nothing (void). The listener is cleaned up on unmount.

**Internal refs**: `cellTabs`, `activeCellTab`, `addCellTab`, and `removeCellTab` are stored in refs and synced via effectless `useEffect` calls. This avoids tearing down and re-adding the `keydown` listener on every keystroke.

---

### `useProjectWorkflow({ kernelStatus, currentProjectDir, cellTabs, ... })`

**Purpose**: Orchestrates project save/load/new flows.

**Takes**: Kernel status, project dir, cell tabs, config, and setters for all project-related state. Also takes `loadedProjectTabsRef` and `normalizeLoadedCodeCells` for processing loaded project data.

**Returns**:
- `handleSaveProject(options?)` — saves the current project (prompts for directory if needed)
- `handleOpenProject(path)` — loads a project from the given path
- `executeOpenProject(path)` — opens a project directly

**Menu listener**: Subscribes to `window.pdv.menu.onAction()` for File menu actions (save, open, close, recent project).

---

## Hook Dependency Graph

```
                    ┌──────────────┐
                    │ useLayoutState│  (independent, localStorage)
                    └──────────────┘

                    ┌──────────────┐
          config ──►│useThemeManager│──► monacoTheme ──► CodeCell
                    └──────────────┘

                    ┌──────────────────────┐
    cellTabs ──────►│useCodeCellsPersistence│  (load on mount, save on change)
    activeCellTab ─►│                      │
                    └──────────────────────┘

                    ┌──────────────────────┐
  currentKernelId ─►│useKernelSubscriptions │──► setLogs, setTreeRefreshToken,
                    │                      │    setModulesRefreshToken,
                    │                      │    setCellTabs (on project load)
                    └──────────────────────┘

                    ┌──────────────────┐
  currentKernelId ─►│useKernelLifecycle │──► startKernel(), handleEnvSave(),
  config ──────────►│                  │    handleRestartKernel()
                    └──────────────────┘

                    ┌──────────────────────┐
  shortcuts ───────►│useKeyboardShortcuts   │  (global keydown listener)
  cellTabs ────────►│                      │──► setCellTabs, setActiveCellTab,
  toggleLeftSidebar►│                      │    addCellTab, removeCellTab
                    └──────────────────────┘

                    ┌──────────────────┐
  kernelStatus ────►│useProjectWorkflow │──► handleSaveProject(),
  cellTabs ────────►│                  │    handleOpenProject(),
  config ──────────►│                  │    executeOpenProject()
                    └──────────────────┘
```

## Key Invariants

1. **No circular dependencies** — hooks receive state as props and only call provided setters; they never import or call each other.
2. **One subscription owner** — only `useKernelSubscriptions` registers push subscriptions. Other hooks read state but don't subscribe.
3. **Refresh tokens as triggers** — child components (Tree, NamespaceView, ModulesPanel) receive token props and refetch when they change. They don't subscribe to push events directly. Incrementing a token (e.g. `setTreeRefreshToken(t => t + 1)`) causes any `useEffect` that lists it as a dependency to re-run, acting as a lightweight pub/sub without a state-management library.
4. **Ref-based stability** — `useKeyboardShortcuts` stores frequently-changing values in refs to avoid re-registering the global listener on every render.

---

## Shared Utility Files

### `app/constants.ts`

Named constants for magic numbers used across hooks and components:
- `CELL_UNDO_LIMIT` — max undo snapshots for cell clear/close
- `CODE_CELL_SAVE_DEBOUNCE_MS` — persistence write delay
- `NAMESPACE_REFRESH_INTERVAL_MS` — auto-refresh polling interval
- `MAX_RECENT_PROJECTS` — cap on remembered project paths

### `app/app-utils.ts`

Pure helper functions with no React dependency:
- `normalizeLoadedCodeCells(data)` — validates raw JSON from project files into typed `CellTab[]`
- `normalizeRecentProjects(data)` — deduplicates and caps the recent-project list
- `mergeConfigUpdate(base, updates)` — deep-merges partial config updates (handles nested `settings.appearance`)
