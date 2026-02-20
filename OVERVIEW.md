# OVERVIEW

Physics Data Viewer is an Electron desktop application for interactive physics/scientific analysis workflows using Jupyter kernels.

## What the current code does
- Launches Python kernels directly via ZMQ (no Jupyter server dependency). Julia runtime support is currently deferred.
- Runs user code from Monaco command tabs and displays:
  - stdout/stderr,
  - return values,
  - captured image outputs from kernel display messages.
- Provides a left-side analysis pane with:
  - **Tree** view for browsable nodes and scanned files,
  - **Namespace** view for live variable metadata,
  - **Modules** tab placeholder.
- Supports script workflows:
  - create scripts under the project tree,
  - parse `run(...)` parameters,
  - run scripts with parameter dialog,
  - open scripts in external editor command.
- Persists user/runtime settings and appearance themes.
- Persists command-box tabs to project-local JSON.

## Main subsystems
- `electron/main/`
  - Electron lifecycle and all IPC handlers.
  - Kernel manager with Jupyter message protocol + ZMQ sockets.
  - Config/theme storage and file scanning.
- `electron/preload.ts`
  - Typed safe `window.pdv` API bridge.
- `electron/renderer/src/`
  - React UI (App, Console, CommandBox, Tree, Namespace, dialogs).

## Current constraints
- Several APIs for future features exist but are still stubs (`tree.get/save`, file watch, script reload).
- Modules tab is currently UI placeholder only.
- Tree snapshot path is currently centered on Python kernel implementation.

## Practical intent for agents
When modifying this codebase, preserve the direct-ZMQ architecture and typed IPC contracts, and favor incremental completion of existing partial workflows (plot/namespace/scripts/tree persistence) before introducing broader new frameworks.
