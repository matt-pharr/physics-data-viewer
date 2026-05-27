# PDV Planned Features

This document is a roadmap, not a spec. It lists features planned beyond the current beta1 release, grouped by target milestone. Items are under-specified on purpose — exact scope is decided during implementation. The authoritative design spec is [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Milestones

| Release | Theme |
|---|---|
| **0.2.0-beta2** | Remote execution and AI agent integration |
| **0.3.0-beta3** | Full Julia support |
| **Later beta** | Usability, infrastructure, and hardening — ordering TBD |
| **1.0.0** | Later-beta items complete plus polish |
| **Post-1.0.0** | Aspirational, not committed |

---

# 0.2.0-beta2 — Remote + Agents

The headline shift: PDV becomes usable against remote compute and against external AI coding agents. Two independent tracks that can be developed in parallel.

## Remote track

### UUID-based file storage
Decouple tree paths from on-disk filesystem paths by addressing node payloads by UUID. Prerequisite for incremental save and for remote mode. Tracked separately from the main remote work because it touches serialization and save/load directly.

### Incremental save
Dirty tracking at the node level. On save, only modified nodes are re-serialized; unchanged nodes are left on disk. Project load reads metadata from `tree-index.json` without materializing payloads until accessed. Depends on UUID storage. Folds in the previously separate "re-implement lazy loading" item ([#130](https://github.com/matt-pharr/physics-data-viewer/issues/130)) — the lazy-materialization path lands as part of incremental save rather than as standalone work.

### Full remote mode
Renderer runs locally; main process and kernel run on a remote host over SSH, VS Code Remote-SSH style. All code execution, filesystem, and tree state live on the remote. Local renderer connects, disconnects gracefully on network drop, and reattaches on resume without losing in-memory state.

Scope includes: SSH connection management and credential storage; remote main-process bootstrap; renderer-to-remote-main transport; reconnect/resume protocol; kernel lifecycle across reconnect (folds in what was previously tracked as a separate "kernel reconnect" item).

### Job manager support
First-class integration with HPC job schedulers — SLURM and task-spooler at minimum, with an abstract interface so others (PBS, LSF, SGE) can be added later. Submit, monitor, cancel, and collect results into the tree. Independent of remote mode: a user might run PDV locally and submit jobs over SSH to a cluster, run PDV on a cluster and submit jobs locally, or run PDV on one cluster and submit jobs to another. Keeping this separate from remote mode preserves that flexibility.

## Agents track

### MCP server and visual coupling
Expose the active project's tree, cells, scripts, notes, kernel, and console to external AI coding agents (Claude Code, Codex, Cursor) via a local MCP server. Users bring their own subscription; PDV does not build an agent loop or ship a chat panel. A visual coupling layer highlights nodes and cells currently under agent control and tags agent-originated operations via the existing `origin` field so console/tree can style them distinctly.

Design discussed in detail in [issue #180](https://github.com/matt-pharr/physics-data-viewer/issues/180). Inline ghost-text completions are a separate later-beta follow-up, not part of this work.

## Environments track

### Per-project environment management
Each project owns its own Python environment, isolated from PDV's own runtime and from other projects. The default for newly created projects. Replaces the idea of session environment snapshots — this is the more complete version. Design: **ARCHITECTURE.md §10.5**. Summary: `uv`-managed venvs built fresh in the per-session working directory (so VS Code/Pylance discover them with zero config and the venv needs no garbage collection), with a `pyproject.toml` + `uv.lock` pair committed inside the project save directory as the portable source of truth; `pdv-python` installed from a bundled wheel as an app-managed dep (not listed in the user's pyproject); bundled `uv` binary per platform that interoperates with any system `uv` (shared cache); an in-kernel `pdv.install()` that adds packages without a kernel restart; and a "Packages" tab in project settings layered over `uv add`/`uv remove`. The existing shared-environment flow (§10.2) stays as a parallel mode for conda users. No automatic migration of pre-uv projects. Independent of the remote and agents tracks; can be developed in parallel.

## Data nodes track

### PDVDataset and PDVHdf5 tree node types
First-class tree node types for scientific data files: `PDVDataset` wraps `xarray.Dataset` / NetCDF, and `PDVHdf5` wraps `h5py` files. Both open lazily, expand into the tree to expose variables/groups as children, and treat their host libraries as optional dependencies — projects that don't use them don't pay for them. No metadata caching in the main process; the kernel remains the sole authority on dataset shape and contents. Tracked in [#203](https://github.com/matt-pharr/physics-data-viewer/issues/203). Independent of the other beta2 tracks.

---

# 0.3.0-beta3 — Full Julia Support

The PDV comm protocol is language-agnostic (ARCHITECTURE.md §3). Julia is deferred to its own beta so it can be built on top of a stable remote/agents foundation rather than alongside it.

### Scope
- `pdv-julia` package: Julia equivalent of `pdv-python` with full protocol parity.
- Julia kernel launch path in `KernelManager`.
- `language_mode` field in `project.json` to drive kernel choice at open time.
- `PDVScript` dispatch for `.jl` files.
- Julia integration tests with parity to the Python pytest suite.
- Julia completion provider via the existing `complete_request` IPC.

Target use case: a physicist running a Julia simulation code on a remote cluster, driven from a PDV module. Beta2 remote and agent work must be stable before this begins.

---

# Later Beta

These are the items that should land before 1.0.0 but whose internal ordering isn't yet decided. Expect the list to evolve — some items may be absorbed into others, some may be cut after beta2 user feedback.

### Trust and security model
A trust level for projects (trusted / untrusted) that gates MCP write tools, raw `kernel_execute`, and the existing `unknown`/pickle node type. Needed before 1.0.0 because of community-shared projects and agent access. May need a minimal version earlier if MCP write tools prove too sharp without it. Pairs with enabling Electron `sandbox: true` on all `BrowserWindow`s ([#161](https://github.com/matt-pharr/physics-data-viewer/issues/161)) — both are part of the same hardening pass.

### File-on-disk node type and smart-copy
A user-facing `PDVFile` type for files that live on disk rather than in the kernel namespace, plus a `smart_copy` copy-on-write helper so duplicating a file-backed node doesn't pay full I/O cost until the duplicate is mutated. Materialization is lazy: payloads are only read when accessed. Tracked in [#108](https://github.com/matt-pharr/physics-data-viewer/issues/108).

### Namelist editor
A `PDVNamelist` tree type for Fortran-style namelist files (common in tokamak codes). Comm-based parsing in the kernel, a `gui.json` layout node so module authors can drop a namelist editor into a module UI, and dynamic path binding via dropdown so one editor instance can target different namelist nodes at runtime. Design agreed; implementation not yet scheduled.

### Tree trash / scratch area
A recoverable deletion path for tree nodes — deleted nodes move to a scratch area instead of being destroyed immediately, so accidental deletion is reversible within a session. Tracked in [#160](https://github.com/matt-pharr/physics-data-viewer/issues/160).

### Module editing: commit and push to upstream
For modules installed from a GitHub source, expose an in-app workflow to commit local edits and push them back to the upstream repository, so module authors can iterate on a module from inside PDV without leaving for an external git client. Tracked in [#182](https://github.com/matt-pharr/physics-data-viewer/issues/182).

### Multi-window and session abstraction
Support multiple top-level windows sharing or isolating project state. Tracked in [#167](https://github.com/matt-pharr/physics-data-viewer/issues/167). Blocked on remote mode because the session abstraction needs to cover both local and remote kernels in one design.

### Command palette and tree search
`Cmd+Shift+P`-style palette surfacing all tree actions, script operations, and project commands, with fuzzy search. Tree name/type filtering lives in the same feature — one input, one search surface, not two.

### Inline AI completions
Ghost-text completions in the code cell backed by the user's own Copilot, Claude, or OpenAI subscription. Orthogonal to the MCP agent work — different code path, different UX. Monaco's multi-provider support handles ordering against the existing kernel-backed completion provider.

### Per-node annotations
Free-text notes attachable to individual tree nodes, persisted in `tree-index.json`. Small feature; can ship as a line-item alongside any later-beta release.

### Visual and asset polish
Bundle of small but visible items: audit and replace placeholder icons across the UI ([#118](https://github.com/matt-pharr/physics-data-viewer/issues/118)) and add a theme import capability so users can share custom themes ([#57](https://github.com/matt-pharr/physics-data-viewer/issues/57)). Sized to ride alongside any later-beta release rather than gating one.

---

# 1.0.0

PDV is ready to ship 1.0.0 when the later-beta items are complete and stable, and when a polish pass has closed the rough edges that accumulate across a long beta. The defining test is "the betas shipped, the features work, and the community can pick it up without a PDV author on call."

### Cross-platform readiness
Windows is the one platform-coverage item explicitly attached to 1.0.0. Beta releases target macOS and Linux; a Windows build, installer, and CI matrix entry are required before 1.0.0 because the broader physics community is still substantially Windows-based. Tracked in [#171](https://github.com/matt-pharr/physics-data-viewer/issues/171).

Additional features may be added to this milestone as the beta progresses and user feedback arrives.

---

# Post-1.0.0 Possibilities

Not committed. Here so they aren't forgotten.

- **R kernel support** — `pdv-r` package via IRkernel, reusing the Julia infrastructure. Aspirational; only worth doing if there is clear user demand.
- **Data ingest wizard** — UI-driven import for CSV, HDF5, MATLAB, netCDF, NumPy files. Lowers the barrier for users who don't write code, but that may increasingly be handled by agents instead.
- **Embedded terminal tab** — xterm.js + node-pty pane inside PDV as a convenience layer over the MCP server, so users don't have to alt-tab to an external terminal. Only worth building if users ask for it after the MCP work ships.
