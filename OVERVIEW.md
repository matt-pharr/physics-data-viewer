# Physics Data Viewer (PDV) — System Overview

## 1) Project Purpose

Physics Data Viewer (PDV) is an Electron desktop application intended to become a **hybrid notebook + data tree + workflow environment** for computational and experimental physics analysis.

The core goal is to combine:
- A notebook-like command workflow (command tabs/cells)
- A persistent project data model (the Tree)
- Scripted and reusable analysis workflows (future Modules)
- Eventually, local + remote execution and local + remote data access

Conceptually, this is aligned with OMFIT-like usage patterns where researchers stitch together data and outputs from multiple codes and experiments, but with a modern desktop UI and explicit multi-language backend support.

---

## 2) Current Architecture (Implemented)

## 2.1 Process model

PDV is a standard Electron split architecture:
- **Main process**: kernel lifecycle, IPC handlers, config/theme persistence, filesystem access
- **Preload bridge**: strongly-typed `window.pdv` API
- **Renderer**: React/TypeScript frontend (Tree, Command Box, Console, dialogs)

Key directories:
- `electron/main`: backend process code
- `electron/preload.ts`: renderer-safe bridge
- `electron/renderer/src`: frontend UI
- `electron/main/init`: kernel bootstrapping scripts for Python + Julia

## 2.2 Kernel runtime model

Kernel execution is implemented via **direct Jupyter kernel process launch** (no Jupyter server) using ZeroMQ channels.

Implemented capabilities:
- Start/stop/restart/interruption of kernels
- Execute code and capture stdout/stderr/errors
- Collect completion and inspection responses
- Capture rich display data (images + HTML)
- Run kernel init cells on startup

Current behavior notes:
- UI currently starts Python kernel by default (`pythonPath`-based command)
- Julia plumbing exists in multiple places but UI and script execution are effectively Python-first
- Basic request serialization exists (`waitForAvailability`) to avoid overlapping kernel reads

## 2.3 Tree model

The Tree is intended as the central project data structure.

Today, Tree behavior comes from two distinct mechanisms:

1. **Kernel tree snapshot** (current UI source of truth)
- Renderer calls `tree:list`
- Main asks Python kernel for `pdv_tree_snapshot(path)`
- Python init defines `tree` as `PDVTree` and serializes nodes to JSON-like payloads

2. **Filesystem scanning** (used by script-centric actions)
- `FileScanner` traverses `tree/` folder, infers node types from file extensions, extracts script docstring previews
- Used for script resolution and metadata in script handlers

Important implication:
- There is not yet one fully unified tree authority for all operations.

## 2.4 Frontend UX (implemented)

The renderer currently includes:
- **Command Box**: tabbed Monaco editor tabs, execute button, keyboard execute (`Cmd/Ctrl+Enter`)
- **Console**: chronological execution log with stdout/stderr/result/error/images
- **Tree panel**: expandable rows, right-click context menu, script actions, persistent expansion/selection state
- **Namespace panel**: variable listing, filtering, sorting, auto-refresh
- **Environment selector**: configure Python executable (Julia path captured as deferred)
- **Settings dialog**: shortcuts, themes/colors, runtime paths
- **Modules tab**: currently a placeholder stub (“coming soon”)

## 2.5 Persistence (implemented today)

Current persisted state includes:
- App config/settings in `~/.PDV/settings`
- Themes in `~/.pdv/themes/*.json`
- Tree root directory auto-created in `/tmp/<user>/PDV-<timestamp>/tree`
- Command tabs persisted to `command-boxes.json` in project directory (parent of tree root)

Current persistence constraints:
- No single “project save/open” package format yet
- No formal project metadata/index manifest versioning
- Command box persistence is separate from tree lifecycle semantics

## 2.6 Script workflow (implemented)

Implemented script functionality:
- Create script file from Tree context menu (`Create new script`)
- Open script in configured external editor command
- Parse script parameters (regex-based)
- Run script via `tree.run_script(...)` in kernel
- Reload script in kernel (`pdv_reload_script`)

Python init provides:
- `PDVTree` and `PDVScript`
- Script registration / reload helpers
- Namespace info and tree snapshot helpers
- Plot capture helpers (`pdv_show`) and optional auto-capture behavior

## 2.7 Testing status (implemented)

There are tests for:
- Main-process helper utilities
- Tree service cache behavior in renderer
- Config/theme and tree-root behavior
- File scanner metadata extraction
- Python backend script-runner behavior (pytest)

Current testing depth is strongest around utility and integration scaffolding, lighter on full end-to-end UI/kernel workflows.

---

## 3) Core Vision (Target Final Product)

The long-term product vision should include all of the following major capabilities.

## 3.1 Project-centric workflow

A PDV project should fully capture:
- Tree structure and all associated data assets
- Command box tabs/cells and execution context history (at least code state)
- Enabled modules and module-local settings/state
- Runtime and environment metadata needed to reopen reproducibly

It should support:
- Save
- Save As
- Open
- Recent projects
- Crash-safe recovery where feasible

## 3.2 Scalable data handling (lazy + large data)

Given target workloads in the 100+ GB range, final design should support:
- Lazy loading for large arrays/tables/files
- Metadata-first tree browsing (shape, dtype, schema, preview windows)
- Slice/chunk reads rather than full materialization
- Backend-side handles/proxies for heavy objects
- Optional memory mapping / chunk cache

## 3.3 Dual-language kernel support (Python + Julia)

The final product should allow project-level language selection and full parity where reasonable:
- Start/use Python or Julia per project
- Script create/run/reload in chosen language
- Namespace introspection parity
- Plot capture/native behavior parity
- Compatible module hooks in both languages (or explicit module-language constraints)

## 3.4 Modules framework

Modules are planned as reusable community workflows combining:
- Manifest metadata (UI bindings, actions, params, dependencies)
- Python scripts (and possibly Julia scripts later)
- Optional custom visualizations and scripted pipelines

Expected module UX:
- Discover/install/enable/disable modules
- Module screen with button/action binding to scripts
- Per-module configuration and validation
- Version compatibility with PDV and project schema

## 3.5 Embedded research artifacts in tree

The tree should support non-code artifacts that belong to workflows:
- Markdown notes
- PDF references/reports
- Potentially notebook-like narrative artifacts

This enables reproducible “analysis + interpretation” in one project workspace.

## 3.6 Remote execution and remote data

Target capabilities include:
- Remote kernel execution (similar to VS Code remote workflows)
- Responsive local UI with compute offloaded to institutional resources
- Remote data browsing/loading from servers and experiment data sources
- Authentication/session management and reconnect behavior

This is essential for large-scale simulation/experimental datasets and HPC workflows.

---

## 4) What the Codebase Does Well Right Now

Strengths already present:
- Cleanly separated main/preload/renderer architecture
- Typed IPC contract (`ipc.ts`) covering a broad API surface
- Practical direct-kernel integration without full Jupyter server dependency
- Good initial script workflow foundations
- Real effort on safer path handling / script path validation
- Config/theme persistence and runtime selector already in place

---

## 5) Current Design Friction / Technical Debt to Track

These are important to consider as part of roadmap planning:

1. **Tree authority split**
- Tree data in kernel memory and filesystem scanning are both used, creating consistency risk.

2. **Project persistence is partial**
- No single project package/schema capturing all persistent state and metadata.

3. **Python-first assumptions leak into multiple layers**
- UI startup, script execution, and compatibility checks explicitly gate toward Python.

4. **Large-data strategy is not yet implemented end-to-end**
- Type hints and API signatures suggest lazy data intentions, but concrete lazy loaders/chunk APIs are limited.

5. **Some IPC methods are placeholders**
- `tree:get` and `tree:save` are still stubs (returning `null` / `true`).

6. **Script parameter parsing is regex-based**
- Fragile for complex function signatures, decorators, multiline defaults, typing edge cases.

7. **Watcher and reload UX is incomplete**
- Watch APIs exist but renderer notification integration is TODO.

8. **Security and trust model needs expansion for production-scale use**
- Executable selection and script execution are practical today, but mature trust boundaries/auditability are future work.

---

## 6) Suggested System Trajectory

A practical trajectory toward the target product:

1. Formalize a **project format** (manifest + data index + command box state + module state)
2. Unify Tree into a **single coherent model** with clear kernel/filesystem synchronization semantics
3. Implement true **lazy data adapters** for large datasets (HDF5/Zarr/Parquet/Numpy)
4. Ship **module runtime + manifest schema** and bind Modules tab to real actions
5. Add **Julia parity** gates and test matrix
6. Add **remote execution/data connectors** behind a transport abstraction

---

## 7) Current Product Decisions (Locked)

The following design decisions are now explicit and should guide implementation:

1. **Project persistence mode (near-term): directory-only**
- Primary format is a project directory, not a monolithic archive.
- This avoids unacceptable open-time costs for very large projects.
- Random-access single-bundle packaging is deferred to a far-future phase.

2. **Data authority model: Python kernel is primary**
- GUI should obtain tree state and data operations through the Python kernel APIs.
- Persisted tree-backed objects should carry project-relative file paths.
- Frontend should remain thin and avoid owning complex data logic.
- Runtime model is memory-primary with lazy disk-backed node loading.

3. **Remote connector priority: SSH/SFTP first**
- Remote data ingest/connectors should prioritize SSH/SFTP workflows.
- Architecture should remain field-agnostic so additional connectors can be added.

4. **Language roadmap: Python first, Julia guaranteed**
- Python features are developed first.
- Backend interfaces must avoid Python-only assumptions that block Julia parity later.

5. **Writeback model: working directory + explicit project save**
- Node updates may auto-write into a project working directory for speed/recovery.
- User-facing Save/Save As should checkpoint/commit full project state.
- Recovery snapshots may exist, but explicit Save remains the durable project boundary.

---

## 8) Summary

PDV already has a meaningful foundation: a working Electron shell, typed IPC, direct Jupyter-kernel integration, script workflows, and an interactive Tree/Namespace/Command UX. The major remaining work is to transform this from a local prototype into a robust, project-centric, scalable research platform: complete persistence, true lazy large-data handling, full module system, dual-language parity, and remote/HPC workflows.
