# PDV Planned Features

This document describes all features planned beyond the current state of PDV, organized by release milestone. Features that have already been implemented are removed from this list as they ship.

## Release milestones

| Release | Description |
|---|---|
| **0.0.5** | Current version. Backend refactor complete, modules UX redesign (activity bar icons, File > Import Module... dialog, tree context menu), PDVModule/PDVGui/PDVNamelist tree types, gui.json manifest split (v3), kernel-backed autocompletion and inspect working, E2E integration test infrastructure in place. |
| **0.1.0-beta1** | All remaining Alpha Features (below) are implemented and stable. The application is suitable for active scientific use. |
| **1.0.0** | All Beta Features (below, plus any added during beta) are implemented. The application is suitable for broad community distribution. |

The architecture is specified in [`ARCHITECTURE.md`](ARCHITECTURE.md). Everything in this document is additive to that foundation.

### Implemented (removed from this document)

The following planned features have been completed and are no longer tracked here:

- ~~**Modules System**~~ — manifest, install, import, action binding, per-module settings, module health checks, UI (see [`modules.md`](modules.md))
- ~~**Kernel-Backed Autocompletion**~~ — `complete_request`/`complete_reply`, Monaco completion provider, `inspect_request`/`inspect_reply` for hover info
- ~~**E2E Testing Infrastructure**~~ — integration tests with real kernel processes, `@slow` tagging, fixture-based project tests
- ~~**Markdown Notes in the Tree**~~ — Write tab with tabbed `.md` editor, KaTeX inline/display math preview, Read mode, tree context-menu creation, auto-save, project save/load support

### Cut (removed from roadmap)

- ~~**Tree Watchers and External Editor Hot Reload**~~ — unnecessary; scripts are read from disk at execution time, so there is no stale state to detect
- ~~**Session Restore and Execution History**~~ — cool idea but unclear demand; may revisit based on user feedback

---

# Alpha Features (Target: 0.1.0-beta1)

---

## 1) Modules System — Visual Manifest Editor

### Goal
Complete the modules system with a visual editor for creating and editing `gui.json` + `pdv-module.json` files, so that module authors (physicists) never need to hand-write JSON.

### Already implemented
- **GUI layout engine**: Container-based layout (`row`, `column`, `group`, `tabs`) is fully implemented via `ContainerRenderer`, `InputControl`, `ActionButton`. Module GUIs render in dedicated popup windows with full input/action/namelist support.
- **Namelist editor widget**: Inline editing UI with typed field controls, collapsible groups, batch save, and tooltip hints extracted from source file comments. Supports Fortran and TOML formats with auto-detection.
- **Dynamic namelist path binding**: `NamelistEditor` component accepts a `treePathInputId` prop; `ContainerRenderer` passes `tree_path_input` from gui.json layout nodes. Fully wired.

### Remaining work

#### Visual manifest editor
A GUI tool for creating and editing module manifests (`pdv-module.json` + `gui.json`) without hand-writing JSON. This is the key UX improvement over OMFIT's Tkinter-based approach — module authors should be able to build module GUIs visually.

- **Layout canvas**: Drag-and-drop placement of containers (row, column, group, tabs) and leaf nodes (input, action, namelist). WYSIWYG preview of the resulting module GUI.
- **Input/action property editor**: Select a placed element and configure its properties (label, control type, default value, visibility rules, slider range, etc.) in a side panel.
- **Manifest identity editor**: Form UI for module identity fields (id, name, version, description), compatibility constraints, dependencies, scripts listing, and files.
- **Import/export**: Load an existing `gui.json` + `pdv-module.json` for editing; export to disk. Round-trip fidelity with hand-written manifests.
- **Live preview**: Side-by-side rendered preview of the module GUI as the user edits the layout.

---

## 2) Full Julia Support

### Goal
The PDV comm protocol is designed to be language-agnostic (ARCHITECTURE.md §3). Julia support is explicitly deferred to beta (ARCHITECTURE.md §15). When implemented, Julia should have full parity with Python for all core workflows.

### Planned work
- **Kernel startup**: Add Julia kernel launch path to `KernelManager`. Connection file creation and ZeroMQ socket management are identical to Python.
- **`pdv-julia` package**: Julia equivalent of `pdv-python` — implements `bootstrap()`, `PDVTree`, the `pdv.kernel` comm target, and all message handlers. Serialization formats overlap with Python (`.npy`, `.parquet` are cross-language).
- **Project-level language selection**: Add a `language_mode` field to `project.json` (not currently in schema) to drive kernel choice at open time.
- **Script parity**: `PDVScript` nodes in Julia projects use `.jl` files. Script editor, create/reload actions, and `run_script()` all need language-aware dispatch.
- **Julia integration tests**: Parity test suite comparable to the Python pytest suite.
- **Kernel-backed autocompletion**: The `complete_request` Jupyter protocol message is language-agnostic; the Julia completion provider is registered using the same IPC channel as Python (already implemented for Python).

---

## 3) Remote Execution, Job Managers, and Remote Data Access

### Goal
Remote compute, job management, and remote data access are essential for institutional and HPC workflows where data lives on cluster filesystems and computation must run on those machines rather than the user's laptop. This feature spans four capabilities with staggered delivery across beta1 and 1.0.0.

### Beta1 scope (blocking)

#### Remote executable execution over SSH
First-class support for running pre-compiled binaries on remote hosts via SSH. The workflow: copy input files to the remote, execute the binary, and copy output files back into the tree. This is the fundamental building block for HPC simulation workflows — e.g., setting up, meshing, and running a simulation code like NIMROD on a remote cluster, then collecting results into the tree for analysis.

- **SSH connection management**: Secure storage for SSH keys and credentials. Session-level credential caching. Named connection profiles for frequently used hosts (e.g., "PPPL Stellar," "NERSC Perlmutter").
- **Remote execution IPC**: Channels for file upload, command execution, status monitoring, and result download. All orchestrated from the kernel so modules can script multi-step workflows.
- **Module integration**: Modules can define actions that orchestrate remote workflows — upload inputs, submit runs, monitor progress, download results.

#### Job manager support (SLURM, task-spooler)
First-class support for HPC job schedulers, both local and remote. The key use case: a module sets up a simulation, submits it to a job queue, monitors its progress, and collects results into the tree when complete.

- **SLURM integration**: Submit jobs (`sbatch`), query status (`squeue`, `sacct`), cancel jobs (`scancel`), and retrieve output files. Supports both interactive and batch submission.
- **task-spooler (ts) integration**: For local and lightweight remote job queuing. Same submit/monitor/collect pattern as SLURM.
- **Job monitor UI**: A panel or status area showing active jobs, their queue status, and completion notifications. Completed jobs offer a one-click action to import results into the tree.
- **Extensible scheduler interface**: Abstract scheduler API so additional backends (PBS/Torque, LSF, SGE) can be added without changing core code.

### 1.0.0 scope (blocking)

#### SSH/SFTP file download → tree
Browse and pull remote files or folders directly into the tree over SSH/SFTP. A file browser dialog connects to a remote host, navigates the filesystem, and imports selected files as tree nodes. This is distinct from the beta1 remote execution feature — it is for ad-hoc data acquisition, not part of an automated workflow.

#### Full remote mode (VS Code SSH-style)
The renderer (GUI) executes locally while the main process and Python kernel run on a remote server over SSH. This allows users with remote access to a cluster or workstation to do all code execution remotely, keeping large projects (>100GB) on institutional storage without downloading to a laptop.

- **Architecture**: Similar to VS Code's Remote-SSH — the renderer connects to a remote main process instance. The Electron main process and kernel both run on the remote host.
- **Graceful reconnect**: On network disconnect (lid close, WiFi drop, SSH timeout), the remote kernel and main process continue running. The local renderer reconnects on resume and reattaches to the existing session, preserving the Python namespace and in-memory tree state. This is critical because all data lives in the tree — an ungraceful disconnect must not lose unsaved work.
- **Use cases**: Sensitive data or IP that must not leave institutional servers; projects too large for laptop storage; leveraging remote compute resources for analysis.
- **Relationship to item 6 (kernel reconnect)**: The local kernel reconnect feature (item 6) must be designed with remote abstraction in mind so the same reconnect path works for both local and remote sessions.

### Implementation notes
- The remote execution and job manager features are kernel-side — they use Python libraries (`paramiko`/`fabric` for SSH, subprocess for local) and are accessible from scripts and modules.
- The main process owns SSH connection profiles and credential storage, exposing them to the kernel via IPC.
- Remote mode (1.0.0) is a much larger architectural change that requires rethinking how the main process starts and connects.

---

## 4) Kernel Reconnect on Renderer Reload

### Goal
When only the renderer reloads (Cmd+R, dev hot reload), the kernel and its working
directory are still alive. Currently, the app always starts a fresh session on any
reload. A reconnect path would preserve in-memory tree state and avoid unnecessary
kernel restarts during development and crash recovery.

### Planned work
- **`session:getActive` IPC channel**: On renderer mount, query whether a live kernel
  session exists rather than always starting fresh.
- **`pdv.session.reconnect` comm message**: Let the kernel confirm it is in a valid
  state without re-running `pdv.init`. Kernel responds with its current `working_dir`
  and a state summary.
- **Working directory validation**: Main process verifies the persisted `working_dir`
  still exists and the kernel is responsive before committing to reconnect.
- **Fallback**: If the kernel is dead or unresponsive within a timeout, fall back to
  the current fresh-start path (clean up old dir, start new kernel).

### Constraints
- Requires a coordinated update to `pdv_kernel` (Python side).
- Must be designed with remote abstraction in mind so the same reconnect path works for both local and remote sessions (see item 3, full remote mode). The reconnect protocol should not assume the kernel is a local subprocess.
- Does not cover cross-process-restart reconnect (that requires remote kernel infra, item 3).
- Must not change behavior on a fresh app launch with no prior session.

---

# Beta Features (Target: 1.0.0)

The following features are lower priority than the Alpha Features above. Begin them only once the Alpha Features are stable and 0.1.0-beta1 has shipped. R kernel support is here because its prerequisite (Julia, item 2) is itself a later alpha item, making R genuinely long-horizon. Most other beta items are usability improvements that become important at community scale.

---

## B1) Lazy Loading for Large Data

### Goal
Ensure project save/load does not require fully materializing all tree node data into memory. For datasets in the 100GB+ range, the tree panel should display metadata (shape, dtype, preview) from `tree-index.json` without loading payloads. Users work with large data using Python libraries (`h5py`, `zarr`, `pandas`, `xarray`) in their scripts — PDV does not need its own chunked adapters.

### Planned work
- **Lazy project restore**: On project load, tree nodes show metadata from `tree-index.json` without deserializing payloads. Data is loaded into memory only when the user's script accesses it.
- **UI inspectors**: Better preview/detail views for large arrays and DataFrames in the tree panel — shape, dtype, small head/tail preview, column statistics.

---

## B2) Security, Trust, and Operational Guardrails

### Goal
As modules, remote execution, and community-shared projects arrive, the risk surface expands. A trust model is needed before 1.0.0.

### Planned work
- **Project trust levels**: A project loaded from an unknown or community source is "untrusted" by default. Untrusted projects cannot execute scripts automatically; user must explicitly approve.
- **`trusted=True` gate**: The `unknown` node type (pickle-backed, ARCHITECTURE.md §7.2) is already gated on `trusted=True` in `serialization.py`. This flag should be surfaced in the UI and tied to the project trust level.
- **Signed modules**: Optional code-signing for module manifests. Allowlist policy for institutional deployments.
- **`moduleWindows:executeInMain` sender validation**: The IPC handler currently executes arbitrary code from any renderer window. Before remote kernel support, validate that the sender is an authorized module window (e.g. by checking `event.sender` against known module window webContents IDs).
- **Execution audit trail**: Optionally record who ran what and when (user identity, script path, timestamp) for reproducibility in shared research environments.

---

## B3) R Kernel Support

### Goal
R is widely used in experimental physics and statistics communities. The PDV comm protocol is language-agnostic (ARCHITECTURE.md §3). R has lower priority than Julia — implement Julia first and then reuse the same infrastructure.

### Planned work
- **IRkernel**: R support in Jupyter uses [IRkernel](https://irkernel.github.io/). `KernelManager` kernel launch and ZeroMQ socket management are identical to Python and Julia — no transport changes needed.
- **`pdv-r` package**: Implemented as an R package. Registers the `pdv.kernel` comm target with IRkernel, implements `PDVTree` as an R environment subclass, and handles all PDV message types. Serialization: Parquet via the `arrow` package; `.npy` exchange with Python requires a bridge (`reticulate` or a standalone reader).
- **Project-level language selection**: `project.json` `language_mode` field (added for Julia, item 2) gains `"r"` as a valid value.
- **Script nodes**: `PDVScript` nodes in R projects use `.R` files. The `language` field in the node descriptor (ARCHITECTURE.md §7.3) is already a free string.
- **Autocompletion**: `complete_request` is language-agnostic; register an R completion provider using the same IPC channel as Python and Julia.
- **R integration tests**: Parity test suite run against a real IRkernel process.

### Notes
- Do not begin until Julia support is complete and validated.
- Cross-language data exchange (opening a Python project in an R session) requires that shared formats (Parquet, JSON scalars) are handled correctly by both serializers. `.npy` files are not natively readable in R without a bridge.

---

## B4) Visualization Panel

### Goal
Matplotlib figures currently appear as static images in the Console via `display_data` output — ephemeral and disconnected from the data that produced them. A dedicated visualization surface would be a major usability improvement for scientific users.

### Planned work
- **Plot panel**: A persistent dockable panel that displays the most recently emitted figure, separate from the text console. Keeps the console clean for text output.
- **Interactive plot rendering**: Plotly and Bokeh output is HTML/JS; the plot panel renders it in a sandboxed `<webview>`, making interactive hover, zoom, and selection actually usable.
- **Integration with figure nodes**: `pdv.save_figure()` saves the current plot to the tree; the plot panel shows a live preview of the unsaved current figure. These are complementary — the panel is transient, the tree node is persistent.

---

## B5) Tree Search and Filtering

### Goal
When a project grows to hundreds of nodes — realistic for any serious experiment — the tree panel becomes difficult to navigate without search. A filter bar is table-stakes for usability at scale.

### Planned work
- **Filter bar**: A text input above the tree panel that filters visible nodes by name substring in real time. Matching nodes and their ancestors remain visible; non-matching nodes are hidden.
- **Type filter**: Toggle buttons or a dropdown to show only nodes of a given type (e.g., `script`, `ndarray`, `figure`).
- **Search**: A deeper search (Cmd+F or command palette entry) that queries node names, preview text, and Markdown content across the full tree, not just the currently expanded subtree.

---

## B6) Data Ingest Wizard

### Goal
There is currently no way to get data into the tree without writing code. For scientists with existing files (CSV, HDF5, MATLAB `.mat`, netCDF), a UI-driven import flow lowers the barrier significantly — especially for experimentalists who are not primarily programmers.

### Planned work
- **Import dialog**: Browse to a file, PDV detects format and shows a preview (column names, shape, dtype), user assigns a tree path and clicks Import.
- **Supported formats at launch**: CSV (→ DataFrame), HDF5 (→ folder of arrays), NumPy `.npy`/`.npz`, MATLAB `.mat` (via `scipy.io`), netCDF (via `netCDF4` or `xarray`), plain text.
- **Batch import**: Select a directory; PDV proposes a tree structure mirroring the directory layout, user confirms or edits before importing.
- **IPC path**: Import is executed by the kernel (not the main process) so that format detection and loading use the full Python scientific stack.

---

## B7) Physical Units and Quantity Metadata

### Goal
NumPy arrays in physics contexts almost always represent quantities with units (Tesla, milliseconds, keV). If that information is stripped when data enters the tree, users must remember and document it themselves through variable names or comments — a common source of errors.

### Planned work
- **`pint.Quantity` node type**: Recognize `pint.Quantity` objects in `serialization.py`'s `detect_kind()` and serialize them with their unit string preserved alongside the numeric payload.
- **`units` metadata field on node descriptors**: A lightweight alternative that does not require `pint` — any node can carry an optional `units: string` in its `tree-index.json` descriptor. Available to all node types, not just arrays.
- **UI display**: The tree panel shows the `units` field in the node preview (e.g., `float64 array (1024,) [T]`). Node detail pane shows full unit string.
- **User-editable units**: The node detail pane allows the user to set or correct the `units` field on any node without re-running code.

---

## B8) Per-Node Annotations

### Goal
Scientists frequently need to annotate individual data nodes: "this was the bad shot," "calibration from 2025-01-15," "rerun with corrected geometry." Currently the only way to attach a note to a node is to create a sibling Markdown node manually.

### Planned work
- **`annotation` field on node descriptors**: A free-text string stored in `tree-index.json` alongside the other node metadata. Writable by the user from the tree panel detail pane.
- **UI**: The tree panel shows an annotation indicator icon on nodes that have one. Hovering shows the full text as a tooltip. Clicking opens an inline edit field.
- **Persistence**: Written to `tree-index.json` at save time, restored at load time. No kernel round-trip needed — the main process owns this field.

---

## B9) Reproducible Environment Lockfiles

### Goal
The architecture detects and installs Python environments but does not record which package versions were active during a session. For reproducible science, a project should be able to declare its computational environment so that results can be reproduced later or by a collaborator.

### Planned work
- **Session environment snapshot**: At save time, run `pip freeze` (or `conda env export`) in the active environment and write the output to `requirements-session.txt` (or `environment-session.yml`) in the project save directory.
- **`project.json` extension**: Add a `environment_snapshot` field pointing to the snapshot file and recording Python version, platform, and PDV version.
- **UI display**: The project info panel (or Settings dialog) shows the environment that was active when the project was last saved, with a warning if the current environment differs significantly.
- **Off by default**, on by default for new projects (configurable).

---

## B10) Command Palette

### Goal
A `Cmd+Shift+P`-style command palette for discoverability. Scientists exploring a new tool will not read documentation — they will press the keyboard shortcut they know from VS Code and expect to find things. A command palette surfaces all tree actions, script operations, project commands, and settings behind a single searchable interface.

### Planned work
- **Global keybinding**: `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows/Linux) opens the palette from anywhere in the UI.
- **Command registry**: A central registry of all available commands with labels, descriptions, and keyboard shortcuts. Module actions and script actions register entries here automatically.
- **Fuzzy search**: Type to filter commands by keyword. Recent commands shown at the top.
- **Context sensitivity**: Commands that are not applicable in the current state (e.g., script actions when no script is selected) are greyed out rather than hidden, so users can discover them without confusion.

---

## B11) GitHub Copilot and/or Claude Integration

### Goal
Surface GitHub Copilot completions and chat inside the PDV code editor. PDV's Monaco-based code cells should feel like a first-class Copilot-enabled editor for physicists: inline ghost-text completions as you type, and a Copilot Chat panel for asking questions about data, scripts, and analysis.

### Background
GitHub Copilot is exposed to third-party editors through two mechanisms:
- **Language Server Protocol (LSP)**: [copilot-language-server](https://github.com/github/copilot-language-server) is a standalone Node.js binary (distributed via npm) that speaks a Copilot-extended LSP protocol. Editors register with it to receive inline completions.
- **GitHub Copilot Chat**: Requires the Copilot Chat API, currently gated behind GitHub's partner programme.

### Planned work

#### Authentication
- The `copilot-language-server` handles GitHub OAuth itself (browser redirect to `github.com/login/device`). PDV's main process spawns the language server and opens the device-activation URL in the system browser.
- Token storage: the language server manages its own token cache (`~/.config/github-copilot/`). PDV does not store credentials.

#### Language server lifecycle
- `copilot-ls.ts` (new main-process module): spawns `copilot-language-server --stdio` as a child process using the npm-installed binary; implements the LSP `initialize` / `initialized` handshake; forwards `textDocument/didOpen`, `textDocument/didChange`, and `getCompletions` over `stdin`/`stdout`.
- Gracefully degrades: if the binary is not installed, Copilot features are silently absent (no hard dependency).

#### Monaco inline completions
- Register a Monaco `InlineCompletionsProvider` for `python` (and `julia` when Julia support lands).
- On each completion trigger, send `getCompletions` to the language server via the `copilot:complete` IPC channel and return the results as `InlineCompletion` items.
- Ghost text rendering uses Monaco's built-in inline completion UI — no custom rendering required.

#### PDV MCP Server
- The AI integration needs to have access to query the tree structure and the current code cell content. This should be discussed further before implementation.

#### IPC surface
- `copilot:status` — returns `'not-installed' | 'signed-out' | 'signed-in'`.
- `copilot:signin` — triggers the device-flow OAuth sequence; returns the activation URL to display.
- `copilot:complete` — forwards a completion request to the language server; returns `{ completions: string[] }`.

#### Settings integration
- Add a **Copilot** section to the General settings tab: enable/disable toggle, sign-in/sign-out button, status indicator.
- Respect the `quickSuggestions: false` Monaco option — Copilot inline completions are a separate provider and are unaffected by that option.

#### Copilot Chat (later)
- Copilot Chat requires access to the GitHub Copilot Chat API. Gate this behind a separate feature flag until API access is confirmed.
- If available: a collapsible chat panel alongside the namespace/tree panes, pre-seeded with the active cell's code and the current tree structure as context.

### Notes
- Inline completions do not require Copilot Business/Enterprise; a standard Copilot Individual subscription is sufficient.
- The language server binary must be installed separately (`npm install -g @github/copilot-language-server` or bundled). Document both paths.
- Kernel-backed autocompletion is already implemented and ships separately from Copilot. This feature adds AI-powered ghost-text completions on top of the existing kernel completions.

---

# Known Design Tensions to Resolve

These are architectural decisions in the current design that are correct for v0.0.5 but will create friction as the system grows. They should be resolved before or during the remaining Alpha Feature implementation.

## Dot-delimited tree paths and key collision
`PDVTree` supports dot-separated path notation (`pdv_tree['data.waveforms.ch1']`). Keys that themselves contain dots are ambiguous — `pdv_tree['my.key']` is indistinguishable from `pdv_tree['my']['key']`. This is acceptable for alpha (physics variable names rarely contain dots) but needs a resolution before community use. Options: escape sequences, a separate `pdv_tree.at('my.key')` method for literal keys, or abandoning dot notation in favour of `pdv_tree['my']['key']` exclusively.

## Working directory is local-only
By design, the working directory is a local temp path passed to the kernel via `pdv.init` (ARCHITECTURE.md §4.1, §6.1). This is correct for local execution but is the primary constraint for the full remote mode (see item 3, 1.0.0 scope). When remote execution is designed, this contract must be explicitly renegotiated.

## Autosave is reserved but unimplemented
The working directory structure includes a `.pdv-work/autosave/` path (ARCHITECTURE.md §6.1). The autosave feature is not designed yet. This directory should not be used for other purposes.

## Console history is ephemeral
Console output is intentionally not persisted (ARCHITECTURE.md §9.4). This is by design — the console is a transient display surface, not a record.

---

# Suggested Implementation Sequence

## Remaining Alpha Features → 0.1.0-beta1

The primary beta use case is a Julia module for a specific simulation code running on a remote cluster. Items 2→3→4 form a sequential dependency chain; item 1 is independent and can be built in parallel.

### Track A: Remote Julia stack (sequential)

1. **Julia parity + tests (item 2)** — Foundation. Port `pdv-python` to Julia, implement `pdv-julia` package with full protocol support. Enables building the target Julia simulation module.
2. **Remote execution over SSH + job managers (item 3, beta1 scope)** — Builds on Julia. SSH connection management, file upload/download, SLURM/task-spooler integration. The target workflow: configure simulation in GUI, submit to cluster, collect results into tree.
3. **Kernel reconnect / remote session persistence (item 4)** — Capstone. Remote kernel outlives SSH connection. PDV reconnects, queries kernel state, rebuilds tree and GUI. Hardest piece — touches kernel lifecycle, comm protocol, and renderer state reconstruction.

### Track B: Visual manifest editor (parallel)

4. **Visual manifest editor (item 1)** — Purely renderer-side, no kernel/protocol changes. Can be built in parallel with Track A. Benefits from having a working Julia module to dog-food against.

## Beta Features → 1.0.0

Begin only after 0.1.0-beta1 is stable. Suggested order:

1. B1 — Lazy loading for large data (rescoped: lazy project restore + UI inspectors)
2. B2 — Security, trust, and operational guardrails
3. B5 — Tree search and filtering (cheap, high daily-use impact)
4. B10 — Command palette (discoverability, especially for new users)
5. B4 — Visualization panel
6. B6 — Data ingest wizard
7. B7 — Physical units and quantity metadata
8. B8 — Per-node annotations
9. B9 — Reproducible environment lockfiles
10. B11 — GitHub Copilot integration (inline completions; Chat if API access granted)
11. B3 — R kernel support (last; requires Julia to be complete first)

---

# Release Completion Criteria

## 0.1.0-beta1 — Alpha Feature Complete

PDV is ready to ship 0.1.0-beta1 when all of the following are true:

- ~~Projects open and save reliably with complete state; older project files load without data loss~~ ✅
- ~~Code cell state is project-managed and recoverable~~ ✅
- ~~Kernel-backed autocompletion works in the code cell for Python~~ ✅
- ~~Modules are installable and runnable via manifest-driven UI actions~~ ✅
- ~~Module GUI supports relative layout~~ ✅ — and a visual manifest editor is available
- ~~Markdown notes are first-class tree nodes with KaTeX math support~~ ✅
- Remote executable execution and job manager support (SLURM, task-spooler) are production-usable
- Kernel reconnect works on renderer reload and is designed with remote abstraction
- Python and Julia have practical parity for all core workflows
- ~~E2E test coverage spans kernel startup, execution, tree save/load, and script execution~~ ✅

## 1.0.0 — Beta Feature Complete

PDV is ready to ship 1.0.0 when all of the following are additionally true:

- Lazy loading ensures large projects (100GB+) load without materializing all data
- A trust model governs untrusted projects and unsigned modules
- SSH/SFTP file download into the tree is production-usable
- Full remote mode (VS Code SSH-style) with graceful reconnect is production-usable
- Tree search and filtering work reliably across projects with hundreds of nodes
- A command palette surfaces all actions and is the primary discoverability mechanism
- A visualization panel provides a persistent, interactive plot surface
- A data ingest wizard supports importing CSV, HDF5, MATLAB, netCDF, and NumPy files without writing code
- Physical units are preserved through the tree for arrays and scalars where provided
- Per-node annotations are supported and persisted in the project
- Session environment is snapshotted at save time for reproducibility
- R kernel support is production-quality with parity to Python for core workflows
