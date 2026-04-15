# PDV Planned Features

This document is a roadmap, not a spec. It lists features planned beyond the current beta1 release, grouped by target milestone. Items are under-specified on purpose — exact scope is decided during implementation. The authoritative design spec is [`ARCHITECTURE.md`](ARCHITECTURE.md).

Beta1 is the current starting point. Everything below is forward-looking.

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
Dirty tracking at the node level. On save, only modified nodes are re-serialized; unchanged nodes are left on disk. Project load reads metadata from `tree-index.json` without materializing payloads until accessed. Depends on UUID storage.

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
Each project can declare and manage its own Python environment, isolated from PDV's own runtime and from other projects. Replaces the idea of session environment snapshots — this is the more complete version. Design: **ARCHITECTURE.md §10.5**. Summary: `uv`-managed venvs keyed on a manifest `project_id`, venvs stored outside the project under `<user-data>/pdv/envs/<project-id>/`, a `pyproject.toml` + `uv.lock` pair committed inside the project as the portable source of truth, `pdv-python` installed as an app-managed dep (not listed in the user's pyproject), bundled `uv` binary per platform, and a "Project Packages" UI layered over `uv add`/`uv remove`. The existing shared-environment flow (§10.2) remains the default and the fallback for conda users. Independent of the remote and agents tracks; can be developed in parallel.

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
A trust level for projects (trusted / untrusted) that gates MCP write tools, raw `kernel_execute`, and the existing `unknown`/pickle node type. Needed before 1.0.0 because of community-shared projects and agent access. May need a minimal version earlier if MCP write tools prove too sharp without it.

### Multi-window and session abstraction
Support multiple top-level windows sharing or isolating project state. Tracked in [#167](https://github.com/matt-pharr/physics-data-viewer/issues/167). Blocked on remote mode because the session abstraction needs to cover both local and remote kernels in one design.

### Command palette and tree search
`Cmd+Shift+P`-style palette surfacing all tree actions, script operations, and project commands, with fuzzy search. Tree name/type filtering lives in the same feature — one input, one search surface, not two.

### Inline AI completions
Ghost-text completions in the code cell backed by the user's own Copilot, Claude, or OpenAI subscription. Orthogonal to the MCP agent work — different code path, different UX. Monaco's multi-provider support handles ordering against the existing kernel-backed completion provider.

### Per-node annotations
Free-text notes attachable to individual tree nodes, persisted in `tree-index.json`. Small feature; can ship as a line-item alongside any later-beta release.

---

# 1.0.0

PDV is ready to ship 1.0.0 when the later-beta items are complete and stable, and when a polish pass has closed the rough edges that accumulate across a long beta. No fixed feature list — 1.0.0 is defined by "the betas shipped, the features work, and the community can pick it up without a PDV author on call."

Additional features may be added to this milestone as the beta progresses and user feedback arrives.

---

# Post-1.0.0 Possibilities

Not committed. Here so they aren't forgotten.

- **R kernel support** — `pdv-r` package via IRkernel, reusing the Julia infrastructure. Aspirational; only worth doing if there is clear user demand.
- **Data ingest wizard** — UI-driven import for CSV, HDF5, MATLAB, netCDF, NumPy files. Lowers the barrier for users who don't write code, but that may increasingly be handled by agents instead.
- **Embedded terminal tab** — xterm.js + node-pty pane inside PDV as a convenience layer over the MCP server, so users don't have to alt-tab to an external terminal. Only worth building if users ask for it after the MCP work ships.
