# Julia Backend — Known Issues

Tracking list for the Julia backend (`pdv-julia` / PDVKernel.jl) shipped on
`feature/julia-backend`. Split into user-reported bugs, known parity gaps
against the Python backend, rough edges, and test-coverage gaps. Items should
graduate to GitHub issues as they're triaged.

Last updated: 2026-07-15.

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

### 17. ~~Strict `::Float64` kwargs reject JSON/UI integers~~ — FIXED (2026-07-14, revised 2026-07-17)
GUI/MCP params cross a JSON boundary, so `tmax: 40` arrived as `Int64` and
MethodError'd against `tmax::Float64`. `script_run` now coerces numeric
kwargs to the `run()` signature's declared numeric types at the call
boundary — verified-lossless conversions only. **Revised 2026-07-17 (PR #347
review):** "Integer → float is lossless" was false above the float type's
mantissa width (2^53 for Float64, 2^24 for Float32) — a big Int would have
silently rounded. Each conversion is now guarded by an exact round-trip
check (and integral float → declared integer type by its natural
InexactError); anything unrepresentable passes through untouched and
MethodErrors loudly, so `n=2.5` against `::Int` still errors and
`2^53 + 1` against `::Float64` errors instead of rounding.

---

## Known parity gaps vs the Python backend

### 5. ~~No per-project environments (biggest gap)~~ — FIXED (2026-07-14)
Pkg-managed per-project environments shipped (ARCHITECTURE.md §10.6, the uv
analog). New Julia projects are always pkg-mode — no dialog, because Julia's
stacked `LOAD_PATH` makes the project env strictly additive (a globally
installed package stays visible; PDVKernel/IJulia keep resolving from the
default env, so they never appear in the user's `Project.toml`). Mechanics:
`Project.toml`/`Manifest.toml` ride the env-file save/open flow, the kernel
spawns with `JULIA_PROJECT=<working-dir>` (native activation, no kernel-side
code), and `Pkg.instantiate` runs **concurrently with the kernel boot** behind
the EnvSyncModal (zero added wall-clock warm; streamed download/precompile
progress cold). `PDVKernel.install()` now records into the project env;
`PDVKernel.remove`/`update` added. The manifest records
`environment: { mode: "pkg", julia_version }`. Restart snapshots the env files
(and now relaunches on the recorded executable instead of the PATH shim —
also fixed for shared Julia restarts). Legacy shared-mode Julia projects keep
opening shared; no auto-migration.

~~Residual: the Packages settings tab shows only a badge + `PDVKernel.install`
hint.~~ Closed 2026-07-15: pkg-mode sessions get the full uv-style CRUD list —
deps from `Project.toml` `[deps]`+`[compat]` with resolved versions from
`Manifest.toml`, and Add/Remove/Upgrade running `PDVKernel.install`/`remove`/
`update` *inside the kernel* (console-bracketed, queued behind running cells,
mirrored to the tab's output pane — §10.6.8). Remaining caveat by design:
what travels is what's *recorded* — a package present only in the user's
default env silently rides the stack locally but won't instantiate elsewhere,
inherent to Julia's stacked-env model and documented in §10.6.1.

### 6. ~~Environment selection is a bare path field~~ — FIXED (2026-07-15)
The selector's Julia tab is now a full discovery list (ARCHITECTURE §10.7,
`julia-discovery.ts`): juliaup channels are read straight from
`juliaup.json` — filesystem-only, no subprocess, so a wedged shim can't hang
discovery — plus the configured path and well-known system locations, each
probed with a single spawn (Julia version + PDVKernel via `locate_package` +
IJulia presence) and badged like the Python rows. One-click **Install
PDVKernel** stages the bundled `pdv-julia` into `<userData>/pdv-julia/` and
runs `Pkg.develop` + `Pkg.add("IJulia")` + a targeted precompile into the
runtime's *default* environment (the stacking-correct target, §10.6.1) with
streaming Pkg output. Shim bypass ships with it: every Julia launch resolves
the configured path through `julialauncher` to the real versioned binary, and
an unconfigured launch uses the discovered juliaup default instead of the
PATH shim. Residual: juliaup-driven *installation* of missing Julia versions
(auto-acquire on `Manifest.toml` version mismatch) — shipped as #19
(2026-07-15).

### 7. ~~Tree browsing stalls during compute-bound execution~~ — FIXED (2026-07-14, revised 2026-07-17)
The query server now runs on a dedicated **spare interactive-pool** OS
thread when one exists (the app spawns Julia with `--threads=auto,2`; a
user-set `JULIA_NUM_THREADS` is respected and falls back to the old
cooperative behavior). Three non-obvious constraints shaped the design, all
verified empirically:
- a thread blocked in `ZMQ.recv` still starves during compute (libuv
  event-loop starvation) — the loop instead polls `sock.events` (a plain
  getsockopt ccall) with `Libc.systemsleep`, measured at 2–7 ms replies
  mid-computation;
- without a GIL the thread must never read live tree values — `tree.list`
  is served from a lock-guarded listings snapshot rebuilt on the main
  thread (tree-changed debounce flush, IJulia postexecute hook, project
  load). Mid-run mutations appear at the next yield (issue 8's contract);
- the loop must NOT live on a default-pool thread (the original 2026-07-14
  design, PR #347 review blocker B1): `@threads :static` pins one task per
  default thread and waits for all of them, so a resident poll loop there
  deadlocked every `:static` loop in the session. It now runs
  `@spawn :interactive` with a `yield()` per tick (the yield keeps it from
  ever starving the sticky root task if scheduled onto tid 1).
`tree.get` / namespace queries reply `query.kernel_busy` and the app falls
back to the comm channel (fast failure instead of a 5 s timeout hang).
Covered by integration tests that query mid-compute (sub-2 s listing) and
run a `@threads :static` loop to completion against the live query server.

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
HDF5 files are part of the same story: browsable `.h5` nodes are the
`PDVHdf5` design (PLANNED_FEATURES, issue #203, beta2) and will need
`HDF5.jl` on the Julia side; a display-only stopgap (live `HDF5.File`
handles browsing as read-only mappings, like NamedTuples below) was
considered 2026-07-15 and deliberately deferred to #203 so persistence
semantics ship correct the first time.
Related display gap closed 2026-07-15 (user request): **NamedTuples** now ride
the `mapping` kind — expandable in the tree by field name (read-only children),
dot-path navigable, `NamedTuple` chip, namespace-view children — while still
persisting as a single `.jls` leaf so the concrete type survives save/load
(ARCHITECTURE §7.2). Checksums flavor-tag them (nt ↔ Dict swaps digest
differently); NamedTuples in pre-existing saves digest differently than before
(one-time cosmetic ⚠ on reload of an old save holding one).

---

## Rough edges

### 10. First-use JIT latency — BOOT PATH FIXED (2026-07-15)
The boot-path half of this issue is fixed (ARCHITECTURE §10.8): both kernel
boot waits now use **activity-based deadlines** — a 30 s / 60 s *idle*
timeout that resets whenever the kernel shows signs of life (process
stdout/stderr during IJulia's own boot; iopub `stream` traffic during the
bootstrap's `using PDVKernel`), under 15 / 20-minute hard caps. A
post-update recompile can no longer blow the boot allowance while printing
progress, but a silently wedged kernel still fails in 30–60 s. The progress
itself now streams (ANSI-stripped) into the EnvSyncModal, which swaps its
subtitle to "Precompiling packages…" when it sees Pkg's output — no more
bare spinner. The wedged-shim failure mode is closed by issue 6's automatic
shim bypass (every launch spawns the real versioned binary), and the
one-click PDVKernel install runs a targeted `Pkg.precompile` so the first
boot after an install doesn't pay compile cost blind.

What remains (inherent, not boot-path): the first *mid-session* import of a
cold module combo (SciML↔Makie extension caches, measured at **10.5 min**)
still stalls the busy kernel, and tree queries/completions time out during
it (issues 7/11) with only the console's streamed output as feedback.
Pre-warm with `julia -e 'using DifferentialEquations, CairoMakie'` before a
live demo. First solve/plot JIT (~10–30 s) is unchanged and cached
afterwards.

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

### 18. Revisit calling lib functions from code cells (ergonomics + stale standalone libs)
Marked for revisit (Matt, 2026-07-15). Two threads:

- **Cell-side ergonomics.** Libs `include` into `Main` as a module named
  after the file stem, so cells must call `mylib.smooth(x)` qualified or run
  `using .mylib` by hand — unlike scripts, which get `using Main.<lib>`
  injected automatically into their anonymous module. Options to evaluate:
  auto-`using` registered libs into `Main` at load/register time (pollutes
  the user namespace but matches script behavior), a `PDVKernel.libs()`
  helper, or documentation-only.
- **Standalone libs go stale after edits.** The `reload_libs` script-run
  preflight only walks `PDVModule` nodes, so a standalone lib (plain tree
  path) is `include`d at creation/project-load and never again — mid-session
  edits don't take effect in cells *or* scripts until reload. Python has the
  same module-scoped preflight (plus `sys.modules` caching), so this is a
  parity-consistent gap, but if standalone-lib editing becomes a common
  workflow both kernels should reload standalone libs in the preflight too.

### 19. ~~juliaup-driven Julia version management~~ — IMPLEMENTED (2026-07-15)

The follow-up half of #6: PDV manages Julia *versions* the way uv manages
Python interpreters. Shipped per the agreed **middle path** (ARCHITECTURE
§10.7.5, `juliaup-runner.ts` — the juliaup single-spawn-site sibling of
`uv-runner.ts`/`julia-env.ts`):

- **Acquisition**: the selector's Julia tab has an "Add a Julia version"
  field running `juliaup add <channel>` streamed (ANSI-stripped) over
  `installOutput`, then rescanning the runtime list. juliaup is located via
  PATH → `~/.juliaup/bin` → Homebrew (GUI apps miss the shell-rc PATH entry).
- **Bootstrap**: when juliaup is absent the tab offers one-click **Install
  juliaup** running the official script (`curl -fsSL
  https://install.julialang.org | sh -s -- --yes`) streamed — it also
  installs a default Julia, covering the nothing-installed case. Windows
  resolves with Microsoft Store guidance.
- **Load-time offer**: opening a pkg project compares the save dir's
  `Manifest.toml` `julia_version` minor against the session and installed
  channels (`juliaVersionCheck` on the load result). Channel installed →
  console pointer to switch under Settings → Runtime; missing + juliaup
  present → confirm dialog offering `juliaup add <minor>`; no juliaup →
  pointer at the bootstrap button. Never blocks the load (§10.6.6).
- Reminder honored in the UI copy: a newly-acquired minor has its own
  default env, so PDVKernel/IJulia need the one-click install (#6) once per
  version — the selector badges surface it.
- **Version picker (2026-07-15, same day):** the **New Julia Project
  dialog** now matches Python's (§10.6.5): a Julia-version dropdown over
  the supported minors (installed juliaup channels marked; missing ones
  "will be downloaded") plus an initial-packages field (`Name@version`
  pins welcome, recorded via `Pkg.add` during the env subprocess).
  `kernels.start` makes the chosen minor launchable before the spawn
  (`ensureJuliaVersionReady`: `juliaup add` + the #6 PDVKernel install as
  needed, streamed into the launch overlay) — the full uv "downloaded
  automatically" experience. Without juliaup the dialog degrades to the
  configured runtime with a pointer at the one-click bootstrap.

Original design rationale kept below.

**Original agreed design (2026-07-15):** drive the user's juliaup, never
bundle it.

- **Why not bundle (unlike uv):** uv earned bundling because it is on the hot
  path of every project open and keeps no user-global state. juliaup is
  needed only for rare, explicit version-acquisition events — and it owns
  persistent user-global state (`~/.julia/juliaup/juliaup.json`, the channel
  DB, shims, self-update). A bundled copy co-managing that state with a
  user-installed juliaup is the same class of external-state wedge the #6
  shim bypass just engineered around.
- **Gate on juliaup presence** (we already read its metadata for discovery).
  When absent, offer one-click **"Install juliaup"** running the official
  installer (`curl -fsSL https://install.julialang.org | sh -s -- --yes`)
  with streamed output — covers the nothing-installed case too, since
  juliaup then bootstraps a default Julia; the user ends up with a single,
  standard, self-owned juliaup.
- **Acquisition:** spawn `juliaup add <version>` as an explicit subprocess
  with streamed progress (same pattern as the `Pkg.instantiate` runner).
  The wedge-prone part of juliaup is only the *implicit* self-update inside
  the `julia` shim, which PDV no longer touches.
- **Auto-offer on open:** `Manifest.toml` records `julia_version`; when a
  pkg-mode project's version has no installed channel, offer
  "Install Julia X.Y with juliaup?" instead of today's silent
  warning-and-proceed.
- **Version picker:** a New-Julia-Project (and/or per-project) dropdown fed
  by installed channels, analogous to the uv dialog's Python-version picker.
- **Reminder:** each newly-acquired Julia minor version has its own default
  env (`@v1.x`), so PDVKernel/IJulia need the one-click install (#6) run
  once per version — the selector badges already surface this.

---

### 20. ~~`@threads :static` errors after an interrupted `@threads` run~~ — FIXED (2026-07-15)
User-reported (GPEC's `sum_eigenmode_contributions`): "`@threads :static`
cannot be used concurrently or nested" with no threading visible on the
stack. Root cause is upstream: Base's `threading_run` has **no try/finally**
around its wait loop, so interrupting a running `@threads` loop (PDV's
Interrupt button → SIGINT → InterruptException unwinds the waiting task)
leaks the global `jl_in_threaded_region` flag for the rest of the process.
Every later `@threads :static` then errors (its only guard is that flag)
while `:dynamic` keeps working — classic "worked until I interrupted once".
Fix (revised 2026-07-17, PR #347 review M3): PDVKernel installs an IJulia
**posterror hook** (`_posterror_thread_heal`) that inspects the errored
cell's exception stack and releases exactly one leaked increment per
`threading_run` frame found in an `InterruptException` backtrace, with a
warning explaining what happened. The value is a COUNTER, not a flag — the
original per-cell "clear when nonzero" preexecute heal would underflow it
whenever a background `Threads.@spawn` task was legitimately inside
`@threads` during another cell, permanently re-poisoning `:static`. Manual
escape hatch in any Julia: `PDVKernel.heal_threaded_region_leak!()` (or
`ccall(:jl_exit_threaded_region, Cvoid, ())`). Note PDV's `--threads=auto,2`
spawn gives `@threads` the full default-thread pool; it is not the cause.
Limitation: user code that *catches* the InterruptException itself never
errors the cell, so the hook doesn't see it — use the escape hatch.

### 21. `pdv_tree` is not safe to mutate from user background threads
Documented constraint (PR #347 review): everything PDV does with the tree —
cell code, script runs, comm handlers, the busy-time query-snapshot rebuild —
runs on the **main thread**, so those never race each other. User code that
writes `pdv_tree` from a `Threads.@spawn`ed task on another thread while a
snapshot rebuild walks the live Dicts is a data race (Julia has no GIL; a
Dict mid-rehash can crash the reader), exactly like sharing any
unsynchronized Dict across threads. Compute in the spawned task, assign the
result into `pdv_tree` from the main task (`pdv_tree["x"] = fetch(t)`).
Funneling `setindex!` through a lock would not close this: nested plain
Dicts inside the tree are mutated directly, with no PDVTree hook to lock.

### 22. Namelist editor retypes whole-number reals as integers (pre-existing, BOTH backends)
Not a PR #347 defect — the namelist editor widget's JS JSON boundary
collapses `1.0` to `1` (JSON has one number type and `JSON.stringify(1.0)`
emits `"1"`). Saving an *untouched* namelist can therefore rewrite a Fortran
real field `x = 1.0` as `x = 1`, and a later session's integer coercion can
then turn an edited `0.5` into `0` for a field it now believes is integral.
Fix belongs in `NamelistEditor.tsx` + both kernels' namelist handlers
(preserve the parsed field's original type, not the JSON-inferred one) —
tracked here alongside the M5 null-slot fix until it gets its own pass.

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
