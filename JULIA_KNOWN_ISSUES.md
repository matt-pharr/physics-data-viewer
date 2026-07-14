# Julia Backend — Known Issues

Tracking list for the Julia backend (`pdv-julia` / PDVKernel.jl) shipped on
`feature/julia-backend`. Split into user-reported bugs, known parity gaps
against the Python backend, rough edges, and test-coverage gaps. Items should
graduate to GitHub issues as they're triaged.

Last updated: 2026-07-14.

---

## Reported bugs (user testing, 2026-07-14 — need triage)

### 1. ~~Save doesn't work reliably from the normal UI flow~~ — FIXED (2026-07-14)
Root cause found and fixed: the tree held live `Makie.Figure` values, and the
checksum's structural field walk (run for the autosave cache on every save)
**never terminated** on a figure's cyclic observable graph — the save hung at
100 % CPU. Three stacked defects, all fixed in `checksum.jl`:
- no cycle guard on the recursive struct/Dict walk (figures are cyclic) — now
  an identity-based visited-set feeds a `backref` marker on revisits;
- pathological per-feed costs on GUI objects (`string(T)` on huge Makie
  parametric types, `Serialization` of listener closures) — now name-based
  type tags and name-only function feeds; a live figure digests in ~0.2 s;
- `string(n)` throws `InexactError` on `GeometryBasics.OffsetInteger` (broken
  upstream `zero`) — the scalar feed is now guarded.
Plus a feed budget + `Serialization`-bytes fallback as a safety net, and the
save walker now skips (and reports in `failed_nodes`) any value that even the
jls fallback refuses, instead of aborting the whole save. Figures round-trip:
`serialize`/`deserialize` of a live CairoMakie figure works (~9 MB, ~0.1 s).
Covered by `e2e/julia-makie-save.spec.ts`, which drives the real Save As
dialog (name field + stubbed native picker), a Cmd+S resave, and a reload.
Residual quirk: a tree holding *displayed* figures may show the status-bar
`⚠` checksum-mismatch marker after reload (display state is part of the live
object but not of the reloaded one). Cosmetic; see issue 13.

### 2. Autosave recovery on the welcome screen always boots a Python kernel
Recovering an autosaved **Julia** session from "Recoverable Unsaved Sessions"
starts a Python kernel and then loads the Julia tree into it. The autosave
sidecar manifest records `language: "julia"` (`autosave-sidecars.ts`), but the
welcome-screen recovery path (`onRecoverSession` → `ensureKernel()`) never
reads it — `ensureKernel` defaults to `'python'`. Fix: plumb the sidecar's
`language` through `autosave.scanWorkingDirs` results into the recovery
handler. The same check is worth auditing on the recent-projects list and
restart-recovery paths (project open does peek `language`; recovery may not).

### 3. Makie figures stored in the tree are not double-click showable
`pdv_tree["fig"] = fig` (a `Makie.Figure`) lists as an `unknown` node with no
double-click action. Root cause: the Julia backend registers **no built-in
double-click handlers at all**, unlike Python's `default_handlers.py`
(ndarray → plot, DataFrame/Series → `.plot()`). Parity fix: a
`default_handlers.jl` that lazily registers (gated on the library being
loaded, like Python's `sys.modules` gate):
- `Makie.Figure` / `FigureAxisPlot` → `display(fig)`
- numeric `Vector` → line plot; numeric `Matrix` → heatmap (via whichever
  Makie backend is loaded)
- `DataFrame` → table/summary display
Module-defined types already work via `pdv_handle` methods (the N-pendulum
solution plots fine); this gap is for bare values.

### 4. "New Julia Project" button is not highlighted
The welcome screen renders New Python Project as the primary (filled) button
and New Julia Project as secondary (outline). One-line fix in
`WelcomeScreen/index.tsx` (`btn-secondary` → `btn-primary`) if both should
read as first-class actions.

---

## Known parity gaps vs the Python backend

### 5. No per-project environments (biggest gap)
Julia sessions are shared-mode only: no analog of the uv flow, no per-project
`Project.toml`/`Manifest.toml`, Packages settings tab inactive, dependencies
not recorded in the project manifest. `PDVKernel.install()` works but lands in
the user's global env (`~/.julia/environments/v1.11`), so projects aren't
self-carrying. The Julia-native design is straightforward (per-project
`Project.toml` + `Pkg.activate` at kernel start + `Pkg.instantiate` on open —
Pkg is built in, no bundled binary needed) and is scoped in
PLANNED_FEATURES.md beta3.

### 6. Environment selection is a bare path field
No discovery of juliaup channels / installed Julia versions — the selector is
a manual executable-path input (blank → `julia` on PATH). No pdv-python-style
one-click "Install PDVKernel into this environment" either; installation is a
manual `Pkg.develop(path="pdv-julia")` (or `Pkg.add` once registered).

### 7. Tree browsing stalls during compute-bound execution
The kernel-side query server runs cooperatively (async task), so tree/namespace
queries are served only when the kernel task yields. During a long pure-compute
run, browsing waits until the next yield/finish (the QueryRouter falls back to
the comm channel, which also queues). Python answers live because the GIL makes
concurrent reads safe. Options if this bites in practice: an interactive-thread
server with locking, or the snapshot approach from the original tree-query
design notes.

### 8. Tree-changed pushes flush at yield points
Same cooperative-scheduling root cause as #7: the 100 ms debounce timer can't
fire mid-tight-loop, so mutations made inside a non-yielding loop surface when
it next yields (the renderer's 1 Hz poll is the safety net). Fine in practice;
listed for completeness.

### 9. No Julia equivalents of the xarray node kinds
`dataset`/`dataarray` (and pandas `series`) are Python-library node types with
no Julia counterpart. Julia custom types round-trip via the
`pdv_format`/`pdv_serialize`/`pdv_deserialize` protocol instead. A
DimensionalData.jl mapping could close this if there's demand.

---

## Rough edges

### 10. First-use JIT latency
First import of a module that loads CairoMakie alongside DifferentialEquations
pays a one-time extension precompile per machine — measured at **10.5 minutes**
on an M-series Mac when the SciML↔Makie extension caches are fully cold (they
can go cold again after package updates). First solve/plot pays JIT (~10–30 s).
Cached afterwards. During the stall the kernel is busy, so tree queries and
completions time out too (issues 7/11) and the only feedback is the busy
spinner — worth a "precompiling packages…" indicator eventually. This is also
the most likely way a module demo "hangs" in front of an audience: pre-warm
with `julia -e 'using DifferentialEquations, CairoMakie'` before presenting.

### 11. Completion requests can time out while the kernel is busy
`complete_request` shares the shell channel with execution; a completion issued
mid-run logs a 5 s timeout (`kernels:complete failed`) and returns empty.
Cosmetic (Monaco degrades gracefully), same behavior class as Python.

### 12. Console shows the raw Julia executable path in the status bar
Cosmetic: the interpreter slot shows the full juliaup-resolved binary path
(long). Could display `julia <version>` instead.

### 13. Checksum-mismatch marker after reloading a tree that holds live figures
A reloaded `Makie.Figure` is content-identical but not digest-identical to
the live one that was saved (weak references, display/screen state, and
observable-listener registrations differ between a displayed figure and a
freshly-deserialized one). After reopening such a project the status bar
shows the `⚠` "data may have changed since last save" marker even though
nothing did. Cosmetic — the next save clears it. A future `pdv_digest`
method for figures (e.g. hashing the rendered image) could fix this
properly; natural to bundle with the default-handlers work (issue 3).

---

## Test-coverage gaps (code is language-agnostic + kernel handlers unit-tested,
but not driven end-to-end on a Julia session)

- ~~Save As dialog flow (see #1) and Cmd+S resave.~~ Covered by
  `e2e/julia-makie-save.spec.ts` (2026-07-14).
- Module GUI popup windows (`gui.json` actions building
  `PDVKernel.run_tree_script(...)` invocations) and the namelist editor widget.
- Crash → restart recovery and restart-with-project reload.
- MCP agent tools (`pdv_run`, `tree_*`, `script_run`) against a Julia kernel.
- GLMakie native-window plotting (only CairoMakie inline display is covered).

---

## Fixed in the 2026-07-14 save-bug session (kept for reference)

- Save hung forever on trees holding Makie figures (issue 1 above): cycle
  guard + cheap type tags + guarded scalar feed + feed-budget fallback in
  `checksum.jl`; `is_dataframe` fast-path (the loaded-modules scan ran per
  node on every tree walk).
- Save aborted wholesale on any value `Serialization` refuses: the walker
  (both kernels) now falls back per-node and skips-and-reports via
  `failed_nodes` in the save response; `ProjectManager.save` logs a warning.
- Same hardening mirrored to pdv-python (a lambda in the tree aborted the
  whole Python save the same way).

## Fixed during the 2026-07-14 GUI test pass (kept for reference)

- World-age freeze in comm/query dispatch (packages loaded after bootstrap
  threw MethodError inside handlers) — dispatch now enters via `invokelatest`.
- `.jls` values from not-yet-loaded packages were silently dropped on project
  load — deserialization now auto-`Base.require`s the missing package.
- Checksum instability for Dict-bearing structs across save/load — unknown
  structs now digest structurally (sorted keys) instead of Serialization bytes.
- Double-click plot handler output (comm-side `display`) never reached the
  console — orphan display_data is now forwarded as its own console entry.
- First cell's stdout printed twice — result no longer re-applies streamed
  output.
- Python-branded tree chips for Julia values (`pd.DataFrame` → `DataFrame`).
- `Print` on large arrays dumped every element — now uses the size-limited
  display form.
- Julia script template annotated `pdv_tree::Dict` (never dispatched; PDVTree
  is an `AbstractDict`) — now `::AbstractDict`.
