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

### 2. ~~Autosave recovery on the welcome screen always boots a Python kernel~~ — FIXED (2026-07-14)
The sidecar's `language` now flows `checkForAutosave` →
`autosave.scanWorkingDirs` → the welcome screen (which shows a
`[Julia]`/`[Python]` badge on each recoverable entry) →
`handleRecoverSession` → `ensureKernel(language)`. Recovering while a
mismatched kernel is live restarts it in the autosave's language (behind the
usual dirty-guard). Pre-sidecar autosaves without a manifest still default
to python.

### 3. ~~Makie figures stored in the tree are not double-click showable~~ — FIXED (2026-07-14)
`default_handlers.jl` now registers lazily (gated on `Base.loaded_modules`,
mirroring Python's `sys.modules` gate; user registrations always win):
- `Makie.Figure` / `FigureAxisPlot` → `display`
- numeric `Vector` → `lines`, numeric `Matrix` → `heatmap` + colorbar (via
  the loaded Makie backend; a `[PDV]` notice tells the user to
  `using CairoMakie` when none is)
- `DataFrame` → `display`
Makie figures also gain a lazy `pdv_digest` that hashes the rendered pixels
(`colorbuffer`), which fixes issue 13 below. One residual carved out as
issue 14: a figure that was *displayed* before saving cannot be re-displayed
after reload (dead backend screens); its handler degrades to a `[PDV]`
notice.

### 4. ~~"New Julia Project" button is not highlighted~~ — FIXED (2026-07-14)
Both New Project buttons are now `btn-primary`.

---

### 15. ~~Creating a new Julia lib makes a `.py` file~~ — FIXED (2026-07-14)
`allocateAndRegisterLib` hardcoded the `.py` extension (and wrote the Julia
stub into it). Now language-selects `.jl`/`.py`, the create dialog shows the
right extension, and the Julia stub defines a `module <stem> ... end` wrapper
(the include-based lib loader binds `Main.<stem>` — a module-less stub loaded
but exported nothing).

### 16. ~~Julia scripts have no preview~~ — FIXED (2026-07-14)
Neither kernel ever extracted a doc preview from script source — `doc` only
survived save/load metadata (module scripts looked fine because their
manifests carry `doc`). Both kernels now extract it at `script.register` and
refresh it on `script.params` (the params dialog re-reads the file anyway):
Python takes the module docstring's first line via `ast`; Julia handles a
leading `\"\"\"docstring\"\"\"`, a `#= block =#` (preferring the template's
`Description:` line), or a leading `#` comment.

### 17. ~~Strict `::Float64` kwargs reject JSON/UI integers~~ — FIXED (2026-07-14)
GUI/MCP params cross a JSON boundary, so `tmax: 40` arrived as `Int64` and
MethodError'd against `tmax::Float64`. `script_run` now coerces numeric
kwargs to the `run()` signature's declared numeric types at the call
boundary — lossless directions only (Integer → declared float type, integral
float → declared integer type); everything else passes through, so `n=2.5`
against `::Int` still errors.

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

### 7. ~~Tree browsing stalls during compute-bound execution~~ — FIXED (2026-07-14)
The query server now runs on a dedicated default-pool OS thread when the
kernel has an interactive threadpool (the app spawns Julia with
`--threads=auto,1`; a user-set `JULIA_NUM_THREADS` is respected and falls
back to the old cooperative behavior). Two non-obvious constraints shaped
the design, both verified empirically:
- a thread blocked in `ZMQ.recv` still starves during compute (libuv
  event-loop starvation) — the loop instead polls `sock.events` (a plain
  getsockopt ccall) with `Libc.systemsleep`, measured at 2–7 ms replies
  mid-computation;
- without a GIL the thread must never read live tree values — `tree.list`
  is served from a lock-guarded listings snapshot rebuilt on the main
  thread (tree-changed debounce flush, IJulia postexecute hook, project
  load). Mid-run mutations appear at the next yield (issue 8's contract).
`tree.get` / namespace queries reply `query.kernel_busy` and the app falls
back to the comm channel (fast failure instead of a 5 s timeout hang).
Covered by an integration test that queries mid-compute and asserts a
sub-2 s listing.

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

Related boot-path failure mode, diagnosed 2026-07-14: a **wedged juliaup
self-update** blocks the `julia` shim, so every shim-routed invocation —
including the PDVKernel environment probe — hangs or times out, and PDV
reports "Kernel startup timed out" / "PDVKernel missing" even though the
caches are warm (`using IJulia; using PDVKernel` loads in ~1 s via the real
binary). Anything that serializes precompilation (a stale precompile pidfile
lock from a killed julia, two processes compiling the same packages) produces
the same symptom. Mitigations shipped: the environment probe now uses
`Base.locate_package` + Project.toml instead of `using PDVKernel` (never
compiles, ~1 s), and pointing PDV at the real juliaup-resolved binary
(`~/.julia/juliaup/julia-<ver>/bin/julia`) bypasses the shim entirely — worth
doing automatically when juliaup discovery lands (issue 6). A genuine
post-update recompile blowing the 60 s boot allowance is still possible;
options: detect "Precompiling" on kernel stderr and extend the deadline, or
precompile explicitly with progress UI before spawning the kernel.

### 11. Completion requests can time out while the kernel is busy
`complete_request` shares the shell channel with execution; a completion issued
mid-run logs a 5 s timeout (`kernels:complete failed`) and returns empty.
Cosmetic (Monaco degrades gracefully), same behavior class as Python.

### 12. Console shows the raw Julia executable path in the status bar
Cosmetic: the interpreter slot shows the full juliaup-resolved binary path
(long). Could display `julia <version>` instead.

### 13. Checksum-mismatch marker after reloading a tree that holds live figures — MOSTLY FIXED (2026-07-14)
Makie figures now digest via a lazy `pdv_digest` that hashes the rendered
pixels (`colorbuffer`) — content-faithful and stable across save/load, unlike
the live object graph (weak refs, display state). Caveat: rendering needs an
**activated Makie backend**. A figure that was displayed before saving
references CairoMakie in its `.jls`, so the reload auto-loads and activates
the backend and the digest matches. A figure that was never displayed
reloads with only Makie core available; the digest auto-requires CairoMakie
when installed, otherwise it falls back to the structural walk and the
cosmetic `⚠` marker can appear until the next save. Cosmetic residual only.

### 14. Reloaded previously-displayed figures cannot be re-displayed
A `Makie.Figure` that was displayed before saving serializes with its
backend screens (dead C pointers after reload). Makie's `display` tries to
re-render onto the corpse and fails (`AssertionError: surface.ptr !=
C_NULL`) — and every attempt to sanitize the screens list (at save with
strip-and-restore, at dispatch with a purge) crashed the kernel outright,
so the screens are left untouched. The default handler catches the failure
and prints an actionable `[PDV]` notice (re-run the plotting code) instead.
Figures that were never displayed before saving re-display fine. A real fix
probably needs an upstream-blessed way to detach a figure from its screens
(`Makie.empty_screens!`-ish) or a figure deep-copy for serialization.

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
