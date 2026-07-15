# PDV Planned Features

This document is a roadmap, not a spec. It lists features planned beyond the current beta1 release, grouped by target milestone. Items are under-specified on purpose — exact scope is decided during implementation. The authoritative design spec is [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Milestones

| Release | Theme |
|---|---|
| **0.2.0-beta2** | Remote execution and AI agent integration |
| **0.3.0-beta3** | Julia hardening and ecosystem follow-ups |
| **Later beta** | Usability, infrastructure, and hardening — ordering TBD |
| **1.0.0** | Later-beta items complete plus polish |
| **Post-1.0.0** | Aspirational, not committed |

---

# Shipped

Landed during the beta series and documented in [`ARCHITECTURE.md`](ARCHITECTURE.md); kept here only as a pointer out of the roadmap.

- **UUID-based file storage** — node payloads are addressed by UUID (`tree/<uuid>/<filename>`), decoupling on-disk storage from tree paths.
- **Per-project environment management (uv)** — each project owns a fresh `uv`-managed venv; `pdv.install()` adds packages without a kernel restart; a Project Environment settings tab wraps `uv add`/`uv remove`. Shared/conda environments remain a parallel mode.
- **MCP server and visual coupling** — the active project's tree, cells, scripts, notes, kernel, and console are exposed to external AI agents via a local MCP server, with agent-originated operations tagged through the `origin` field.
- **Namelist editor (`PDVNamelist`)** — a tree node type for Fortran/TOML namelists with comm-based parsing and a `gui.json` layout node bound by dropdown.
- **File-on-disk node type (`PDVFile`) and smart-copy** — a user-facing `PDVFile` (via `pdv.add_file()`) plus a copy-on-write `smart_copy` helper with lazy materialization.
- **Julia kernel backend (`pdv-julia` / PDVKernel.jl)** — full protocol parity with `pdv-python` on top of IJulia: tree types, dot-path access, change pushes, serialization (`.npy` for numeric arrays, Julia `Serialization` elsewhere), query server, script `run(pdv_tree; kwargs...)` contract, module/lib loading via `include` into `Main`, namelist parsing (built-in Fortran parser + TOML stdlib), and `PDVKernel.install()` via Pkg. Covered by a Julia test suite, a `JULIA_PATH`-gated integration suite, and a Playwright GUI smoke spec.

---

# 0.2.0-beta2 — Remote + Agents

The headline shift: PDV becomes usable against remote compute and against external AI coding agents. Two independent tracks that can be developed in parallel.

## Remote track

### Incremental save
Dirty tracking at the node level. On save, only modified nodes are re-serialized; unchanged nodes are left on disk. Project load reads metadata from `tree-index.json` without materializing payloads until accessed. Depends on UUID storage. Folds in the previously separate "re-implement lazy loading" item ([#130](https://github.com/matt-pharr/physics-data-viewer/issues/130)) — the lazy-materialization path lands as part of incremental save rather than as standalone work.

### Full remote mode
Renderer runs locally; main process and kernel run on a remote host over SSH, VS Code Remote-SSH style. All code execution, filesystem, and tree state live on the remote. Local renderer connects, disconnects gracefully on network drop, and reattaches on resume without losing in-memory state.

Scope includes: SSH connection management and credential storage; remote main-process bootstrap; renderer-to-remote-main transport; reconnect/resume protocol; kernel lifecycle across reconnect (folds in what was previously tracked as a separate "kernel reconnect" item).

### Job manager support
First-class integration with HPC job schedulers — SLURM and task-spooler at minimum, with an abstract interface so others (PBS, LSF, SGE) can be added later. Submit, monitor, cancel, and collect results into the tree. Independent of remote mode: a user might run PDV locally and submit jobs over SSH to a cluster, run PDV on a cluster and submit jobs locally, or run PDV on one cluster and submit jobs to another. Keeping this separate from remote mode preserves that flexibility.

The MCP server + visual coupling (Agents track) and per-project uv environment management (Environments track) originally scoped here have shipped — see the **Shipped** section above. Inline ghost-text completions remain a separate later-beta follow-up ([issue #180](https://github.com/matt-pharr/physics-data-viewer/issues/180) has the agent-integration design).

## Data nodes track

### PDVDataset and PDVHdf5 tree node types
First-class tree node types for scientific data files: `PDVDataset` wraps `xarray.Dataset` / NetCDF, and `PDVHdf5` wraps `h5py` files. Both open lazily, expand into the tree to expose variables/groups as children, and treat their host libraries as optional dependencies — projects that don't use them don't pay for them. No metadata caching in the main process; the kernel remains the sole authority on dataset shape and contents. Tracked in [#203](https://github.com/matt-pharr/physics-data-viewer/issues/203). Independent of the other beta2 tracks.

---

# 0.3.0-beta3 — Julia Hardening

The core Julia backend has shipped (see **Shipped** above): `pdv-julia` implements the
full kernel protocol, the app boots Julia sessions from the welcome screen, and the
bundled N-pendulum-julia module targets it. Remaining Julia work is hardening and
ecosystem follow-ups:

### Scope
- Packaging/registration of `PDVKernel.jl` (General registry or app-driven
  `Pkg.develop`) so the app can offer one-click install like it does for pdv-python.
- Julia environment discovery in the Environment Selector (today: manual path entry;
  juliaup-aware discovery planned).
- ~~Tree queries during long compute-bound executions~~ — shipped on the Julia
  backend branch: threaded query server on a default-pool OS thread serving a
  lock-guarded listings snapshot (ARCHITECTURE.md §5.14).
- ~~Per-project Julia environments (the `Project.toml` analog of the uv flow)~~ —
  shipped on the Julia backend branch: Pkg-managed `mode: "pkg"` projects
  (ARCHITECTURE.md §10.6). Follow-up: a `Project.toml`-driven package list in
  the Project Environment tab (today: badge/version + `PDVKernel.install` hint).

Target use case: a physicist running a Julia simulation code on a remote cluster, driven from a PDV module.

---

# Later Beta

These are the items that should land before 1.0.0 but whose internal ordering isn't yet decided. Expect the list to evolve — some items may be absorbed into others, some may be cut after beta2 user feedback.

### Trust and security model
A trust level for projects (trusted / untrusted) that gates MCP write tools, raw `kernel_execute`, and the existing `unknown`/pickle node type. Needed before 1.0.0 because of community-shared projects and agent access. May need a minimal version earlier if MCP write tools prove too sharp without it. Pairs with enabling Electron `sandbox: true` on all `BrowserWindow`s ([#161](https://github.com/matt-pharr/physics-data-viewer/issues/161)) — both are part of the same hardening pass.

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
