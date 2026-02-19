# CURRENT_STATE

## Scope reviewed
- Full review of `electron/` source (main process, preload, renderer, init scripts, and tests).
- Review of `IMPLEMENTATION_STEPS.md` against current implementation.

## High-level status
The project is a working Electron + React desktop app that can:
- launch Python/Julia Jupyter kernels directly via ZMQ,
- execute code from Monaco command boxes,
- show stdout/stderr/results (including captured images),
- browse a tree view (kernel snapshot + filesystem scripts/data),
- run/edit scripts from the tree,
- inspect kernel namespace,
- persist config, themes, and command tabs.

The current architecture is consistent with the direct-kernel approach documented in `IMPLEMENTATION_STEPS.md` (Step 5.5 decision).

---

## Current architecture (what exists now)

### Main process (`/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main`)
- `app.ts`
  - Creates Electron window and menu.
  - Disables normal reload shortcuts; exposes Settings action via IPC event.
- `ipc.ts`
  - Canonical IPC channels and types for kernels/tree/files/config/themes/scripts/namespace/command boxes.
- `index.ts`
  - Registers IPC handlers.
  - Coordinates kernel execution, namespace requests, tree list requests, script actions, config updates, and command-box persistence.
- `kernel-manager.ts`
  - Direct ZMQ kernel launcher.
  - Creates connection files, signs outgoing Jupyter messages, executes code, handles completion/inspect, parses IOPub output including `display_data` images.
- `config.ts`
  - Persists settings in `~/.PDV/settings`.
  - Ensures tree root + `data/scripts/results` directories.
  - Manages themes in `~/.pdv/themes`.
- `file-scanner.ts`
  - Scans files under configured tree root.
  - Classifies scripts/data/config/images and extracts script docstring previews.
- `init/python-init.py`, `init/julia-init.jl`
  - Initialize `tree` object and helper functions (`pdv_info`, `pdv_namespace`, script-run helpers, plot helpers).

### Preload (`/home/runner/work/physics-data-viewer/physics-data-viewer/electron/preload.ts`)
- Exposes typed `window.pdv` bridge for all renderer->main interactions.
- Uses shared IPC constants from `main/ipc.ts` (no duplicated channel map).

### Renderer (`/home/runner/work/physics-data-viewer/physics-data-viewer/electron/renderer/src`)
- `app/index.tsx`
  - Main layout and state orchestration.
  - Kernel lifecycle, execution flow, namespace/tree refresh, settings/environment dialogs, plot mode toggle, command-box persistence.
- Components:
  - `CommandBox`: Monaco editor with tabs, execute, Ctrl/Cmd+Enter.
  - `Console`: execution log rendering with stdout/stderr/result/error/images.
  - `Tree`: expandable tree with context menu, selection persistence, refresh.
  - `NamespaceView`: filters/search/sort/refresh/auto-refresh for namespace metadata.
  - `ScriptDialog`: infers `run(...)` parameters and prompts user.
  - `EnvironmentSelector`: validates/selects runtime executables.
  - `SettingsDialog`: runtime paths, shortcut, and theme customization.
- `services/tree.ts`
  - Tree API wrapper + per-kernel path cache.

### Tests currently present
- Main tests: config, file scanner, kernel manager basics, app import.
- Renderer tests: tree service.
- Existing baseline in this branch before changes:
  - `npm run build` passed
  - `npm test` passed

---

## Code review findings (electron folder)

### Strong points
1. **Direct kernel architecture is implemented and functional**
   - `kernel-manager.ts` launches kernels, wires ZMQ sockets, and executes Jupyter protocol messages.
2. **Typed IPC model is mostly clear and broad**
   - `ipc.ts` defines channels and data contracts for implemented and planned features.
3. **Renderer integration is practical and cohesive**
   - App integrates command execution, console, namespace, tree, script actions, and settings in one flow.
4. **Security-minded path handling exists in key places**
   - Executable validation and multiple script/path sanitization checks are present.
5. **Plot capture plumbing exists now**
   - Python/Julia init helpers + IOPub `display_data` handling + renderer image rendering are in place.

### Gaps / partial implementations
1. **Tree object persistence APIs are still stubs**
   - `index.ts`: `IPC.tree.get` returns `null`; `IPC.tree.save` returns `true` without implementation.
2. **Script reload is a stub**
   - `index.ts`: `IPC.script.reload` currently logs and returns success without reloading behavior.
3. **File watch APIs are stubs**
   - `index.ts`: `IPC.files.watch` / `IPC.files.unwatch` always return `false`.
4. **Tree listing is Python-only today**
   - `listTreeFromKernel` only runs for kernels with `language === 'python'`; Julia tree snapshot path is not implemented.
5. **Modules tab is placeholder UI**
   - Renderer shows "Modules view (coming soon)".

### Redundant / zombie / likely-unused code
Phase 1 cleanup items completed:
1. **Duplicate IPC channel constants in preload** — resolved.
2. **Unused function in Tree component (`applyExpandedState`)** — removed.
3. **Unused dependencies (`@jupyterlab/services`, `ws`)** — removed from `electron/package.json`.

### Areas to rework (non-blocking but recommended)
1. **Split very large handlers/files**
   - `main/index.ts` and `main/kernel-manager.ts` are large; extracting handler modules would reduce risk.
2. **Single source of truth for IPC names**
   - Avoid constant duplication by sharing generated constants/types into preload-safe import path.
3. **Clarify step ownership in docs**
   - Some Step 6/7/8 features are implemented ahead of checklist labels; docs should track "partial/complete" by capability, not only step number.

---

## IMPLEMENTATION_STEPS.md comparison

Status legend used below:
- ✅ implemented
- 🟨 partially implemented
- ⏳ not implemented yet

| Step | Planned feature | Current status | Notes |
|---|---|---|---|
| 0 | Repo scaffolding/tooling | ✅ | Present and working |
| 1 | Electron+Vite shell | ✅ | Implemented |
| 2 | IPC contracts + preload bridge | ✅ | Implemented; preload now uses shared IPC constants |
| 3 | Kernel manager stub | ✅ (superseded) | Replaced by real kernel manager |
| 4 | Console + Monaco command box | ✅ | Implemented with tabs + shortcuts |
| 5 | Tree POC lazy UI | ✅ | Implemented with caching/expand/context menu |
| 5.5 | Real kernel integration (direct ZMQ) | ✅ | Implemented |
| 6 | Plot mode + capture integration | 🟨 | Mode toggle + init config + display image rendering exist; end-to-end behavior hardening still advisable |
| 7 | Namespace view | 🟨 | Query/filter/sort/refresh/auto-refresh implemented; advanced double-click inspect/plot behavior not implemented |
| 8 | Script execution + file ops | 🟨 | Create/run/edit/param extraction implemented; reload + file watch not implemented |
| 9 | Data loaders (real format loaders) | ⏳ | Scanner/classification exists, but true loader backends are not implemented |
| 10 | Object store + persistence | ⏳ | `tree.get/save` and watch support are stubs |
| 11 | Module manifests + dynamic UIs (basic) | ⏳ | Not implemented |
| 12 | Advanced manifest widgets | ⏳ | Not implemented |
| 13 | Packaging/distribution | ⏳ | Not implemented |
| 14 | Docs/polish | 🟨 | Some docs exist; release-grade docs incomplete |

---

## Feature map (implemented, with file references)

- Kernel lifecycle and execution: `main/kernel-manager.ts`, `main/index.ts`
- Kernel config and validation: `main/config.ts`, `main/index.ts`, `renderer/.../EnvironmentSelector`, `renderer/.../SettingsDialog`
- Execution UI and logs: `renderer/src/components/CommandBox`, `Console`, `app/index.tsx`
- Plot image display in console: `main/kernel-manager.ts` (`display_data`) + `renderer/src/components/Console`
- Namespace querying and display: `main/index.ts` namespace handler + `renderer/src/components/NamespaceView`
- Tree listing and scanning: `main/index.ts` + `main/file-scanner.ts` + `renderer/src/components/Tree` + `renderer/src/services/tree.ts`
- Script creation/run/edit/param dialog: `main/index.ts`, `main/init/python-init.py`, `main/init/julia-init.jl`, `renderer/src/components/ScriptDialog`, tree context actions
- Theme and appearance persistence: `main/config.ts`, `renderer/src/components/SettingsDialog`
- Command box persistence: `main/index.ts` command box handlers + `renderer/src/app/index.tsx`

---

## Suggested direction going forward
1. Keep current direct-ZMQ foundation.
2. Prioritize finishing partially implemented primitives before new UI breadth:
   - `script.reload`, file watching, `tree.get/save`.
3. Define "done" by behavior-level acceptance tests for Step 6/7/8, since code already includes part of those features.
4. Treat Step 9/10 as architectural milestones (loader abstraction + persistence model) before Step 11/12 dynamic UI complexity.
