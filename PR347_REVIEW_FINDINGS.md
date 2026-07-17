# PR #347 independent review findings (2026-07-17)

Produced by an independent Fable 5 review agent against `feature/julia-backend`
@ `94a6415`. Verdict: **not mergeable yet** — gate on B1–B3 + M1, M2, M3
(agent suggested also M4/M5/M9 as gates; Matt to confirm). Working TODO for
the fix pass; delete this file (or fold residuals into JULIA_KNOWN_ISSUES.md /
GitHub issues) when the findings are resolved.

Reviewer re-ran and confirmed green: electron 885/885, pdv-julia 428/428,
integration-julia 16/16 (real kernel), `sweep-deps.sh` 16/16 cells.
All 12 CLAUDE.md checklist items pass (script-path and JSDoc each with one
defect noted below). CONFIRMED = failure path traced/reproduced end to end.

## Blockers

- [x] **B1 — FIXED 2026-07-17** (repro'd pre-fix, both fix probes + real-kernel
  regression test green): poll loop moved to a **spare interactive** thread —
  `--threads=auto,2` in kernel-manager.ts + `@spawn :interactive` + a
  per-tick `yield()` (required: the scheduler may place the loop on tid 1,
  where the sticky root task lives — a never-yielding loop there starves the
  kernel outright, a failure mode the reviewer's sketch missed).
  `_can_run_threaded()` now demands the spare interactive thread; `auto,1`
  configs degrade to cooperative mode. New integration test runs `@threads
  :static` to completion against the live query server (287 ms; hung forever
  before). ARCHITECTURE §5.14 + JULIA_KNOWN_ISSUES #7/#20 updated.
  Original finding — `pdv-julia/src/query_server.jl:187–212`:
  threaded query loop runs on a **default-pool** thread (`Threads.@spawn
  :default`) and never reaches a scheduler yield (`sock.events` getsockopt +
  `Libc.systemsleep`), so `@threads :static` — which pins one task per
  default-pool thread — **deadlocks forever** waiting on the occupied thread.
  App always spawns `--threads=auto,1` → affects every Julia session; it is
  the exact GPEC construct behind issue #20 (so Matt's run would HANG next,
  even after the #20 heal). Repro: julia `--threads=4,1`, start the query
  server, `:dynamic` completes / `:static` never does. Pkg.test is
  single-threaded → unit tests can't see it. Also silently steals one default
  thread from user compute.
  **Fix:** run the poll loop on the interactive pool (`--threads=auto,2` +
  `@spawn :interactive`, keeping it off the main tid — `@threads` never pins
  to interactive tids), or add a real `yield()` per tick and accept stalls.
  Must update ARCHITECTURE §5.14 (documents the current default-pool design)
  and re-validate against a real busy kernel + a `@threads :static` loop.

- [x] **B2 — FIXED 2026-07-17** (with M6, one rule): `_serialize_mapping!` now
  routes any Dict with a non-String key to a whole-`.jls` leaf (same rule as
  NamedTuples) — never composite, never inline — so the walker's stringified
  key round-trip is only ever taken for all-String-keyed Dicts, and
  `_container_value`'s dead Symbol fallback is gone. Int-keyed saves
  round-trip with Int keys (new testset). Python got the parity rule in
  `_serialize_mapping` (non-str keys → whole pickle) + mirror test;
  sweep-deps 16/16 green. Original finding — `pdv-julia/src/handlers/project.jl:111–114`
  (`_container_keys`/`_container_value`), fetch outside the per-node rescue
  at :56: save walker stringifies composite-Dict keys and maps back via
  `haskey(c,k) ? c[k] : c[Symbol(k)]`; an **Int-keyed dict** (shot numbers:
  `Dict(1 => rand(3), 2 => rand(3))`) can never resolve → `KeyError` escapes
  the rescue → **every save/autosave aborts** (`project.serialization_error`);
  freshly minted UUID dirs from the failed walk are orphaned.
  **Fix:** carry `(key_object, key_string)` pairs through the walker like
  Python — or classify non-String-keyed Dicts as non-composite whole-`.jls`
  leaves (also fixes M6).

- [x] **B3 — FIXED 2026-07-17**: `extraResources` now ships `../pdv-julia →
  pdv-julia` (test/ and .git/ excluded); new electron-builder-config.test.ts
  guards the manifest against drift (pdv-julia, pdv-python, wheel, uv).
  Original finding — `electron/electron-builder.yml:37–45` vs
  `electron/main/julia-discovery.ts:545–555`: `extraResources` ships
  pdv-python/uv/wheel but **no `pdv-julia`**, while `resolveBundledPDVJuliaPath()`
  + ARCHITECTURE §10.7.4 expect `<resourcesPath>/pdv-julia`. Any packaged
  build: one-click PDVKernel install (and `ensureJuliaVersionReady`'s install
  leg) always fails. Works in dev only via `__dirname` walk-up.
  **Fix:** add `- from: ../pdv-julia, to: pdv-julia` (exclude `test/`) to
  extraResources; add a packaged-path assertion.

## Majors

- [x] **M1 — FIXED 2026-07-17 (both kernels)**: the save walker now reads the
  previous tree-index.json and, when a node fails even the jls/pickle
  fallback, re-appends its prior descriptor (and its children's) — the node
  stays in the new index, the purge keeps its `tree/<uuid>/` snapshot, and a
  reload gets the last good copy back. `failed_nodes` entries gain a
  `preserved` flag. New tests in both suites (Julia 446/446, Python 632
  passed, sweep green). Renderer surfacing of failed_nodes remains the
  separate minor below. Original finding — `pdv-julia/src/handlers/project.jl:76–86`
  + purge :113–144/:409 (and the same pattern in this PR's
  `pdv-python/pdv/handlers/project.py` diff): a node landing in
  `failed_nodes` is excluded from the new tree-index.json, and
  `_purge_orphaned_tree_files` (keyed on the NEW node list) then **deletes its
  previous good `tree/<uuid>/` snapshot**. E.g. value gains a live
  `Task`/`Channel` → next save/autosave silently destroys the last good copy
  (only trace: console.warn). **Fix:** on fallback failure re-use the node's
  descriptor from the existing index (preserve last good snapshot) or exempt
  failed paths' prior UUIDs from the purge; surface `failed_nodes` in the
  renderer (see minor below).

- [x] **M2 — FIXED 2026-07-17**: `scanForAutosaves` now reports `envMode`
  (orphan root has `pyproject.toml` → uv, `Project.toml` → pkg); the welcome
  Recover boots the kernel via `launchUvKernel`/`launchPkgKernel` with the
  orphan as env-file source (same path as opening a uv/pkg project);
  `recoverUnsavedSession` copies all env files from the orphan root into the
  new working dir and REFUSES to delete the orphan when that copy fails. New
  unit tests: scan envMode detection + 4 recovery tests (new
  ipc-register-autosave.test.ts harness). §8.4 updated. Original finding —
  `electron/main/ipc-register-autosave.ts:258–360` +
  renderer `app/index.tsx:1175–1178`: welcome-screen recovery of an unsaved
  pkg-mode Julia session copies tree files/project.json/modules but **not
  `Project.toml`/`Manifest.toml`**, then `fs.rm`s the orphan dir (only copy),
  and boots the recovery kernel shared (no JULIA_PROJECT). Next Save As
  permanently demotes to `mode:"shared"`. Restart path (juliaEnvSnapshot) is
  correct; only welcome recovery loses data. **Fix:** copy `JULIA_ENV_FILES`
  from the orphan during recovery + thread an env snapshot into the recovery
  launch; never delete the orphan's env files.

- [x] **M3 — FIXED 2026-07-17**: heal moved from a blind preexecute decrement
  to an IJulia **posterror** hook that inspects `current_exceptions()` and
  releases exactly one increment per `threading_run` frame found in an
  `InterruptException` backtrace — ordinary errors, non-@threads interrupts,
  and live background `@threads` all leave the counter alone;
  `heal_threaded_region_leak!(n)` caps at zero (no underflow) and stays as
  the manual escape hatch. New tests include a real in-process interrupted
  `@threads` leak healed via the posterror path + the M3 underflow
  regression. Docstring corrected; §5.14 + KNOWN_ISSUES #20 updated.
  Limitation documented: a user-caught InterruptException never reaches the
  hook. Original finding — `pdv-julia/src/handlers/lifecycle.jl:80–87`:
  `jl_in_threaded_region` is a **counter**; extra `jl_exit_threaded_region`
  from 0 underflows (getter reads nonzero again). The preexecute heal
  blind-decrements whenever nonzero; docstring's background-task exemption is
  factually wrong (exit decrements, doesn't zero). Scenario: cell 1
  `Threads.@spawn long_job()` using `@threads`; run cell 2 mid-flight → heal
  decrements 1→0 (also disabling the :static nesting guard); background
  threading_run exits → underflow → `@threads :static` errors PERMANENTLY +
  heal warns every cell. **Fix:** heal only in direct response to an
  interrupted execution (posterror latch on InterruptException with a live
  `@threads` frame), never blind-decrement per cell.

- [x] **M4 — FIXED 2026-07-17**: new exported `juliaStringLiteral()`
  (module-runtime.ts) = JSON.stringify + `$`→`\$`; applied to script.run
  kwargs + tree path, tree.print path, `toJuliaArgumentValue`, and
  `buildModuleActionCode` (full audit of Julia code-string sites). Unit
  tests cover the LaTeX-label case at both layers. Original finding —
  `electron/main/ipc-register-tree-namespace-script.ts:495`:
  Julia arm of the script:run kwargs builder emits string params via
  `JSON.stringify`, which never escapes `$` → `label="$\alpha$ scan"` (LaTeX)
  is a parse error or **silent interpolation of a kernel variable**.
  **Fix:** escape `$` → `\$` after JSON.stringify in every Julia
  string-literal builder (audit for other sites).

- [x] **M5 — FIXED 2026-07-17**: `_parse_fortran_payload` keeps empty tokens
  as `nothing` (a single trailing empty token = idiomatic trailing comma,
  not a slot), making read↔write a fixed point with the writer's existing
  empty-slot emission. Tests: gap slots, indexed-write padding, trailing
  comma, and two-cycle save idempotence. Original finding —
  `pdv-julia/src/namelist_utils.jl:233` (+ indexed
  write :279–289): `_parse_fortran_payload` drops empty tokens, so Fortran
  null slots shift on open-and-save (`x = 1.0, , 3.0` → `[1.0, 3.0]`, 3.0
  moves slot 3→2) — silent physics-input corruption. `y(3) = 5.0` writes
  once correctly but re-reads as scalar → second save corrupts. Python f90nml
  preserves nulls. **Fix:** keep empty tokens as `nothing` (writer already
  emits empty slots for `nothing`) making read↔write a fixed point; add
  gap/indexed/idempotence tests.

- [x] **M6 — FIXED 2026-07-17** (see B2 above — one rule fixes both): Symbol-
  and Int-keyed Dicts persist whole as `.jls`/pickle leaves and round-trip
  their key types; `d[:a]` works after load. Original finding —
  `pdv-julia/src/handlers/project.jl:29`
  (Symbol fallback) + `tree_loader.jl:64–67` (reload as `Dict{String,Any}`),
  masked by `checksum.jl:266–270` (keys feed as `string(key)`): Symbol-keyed
  composite Dicts silently mutate to String keys across save/load with **no
  checksum warning**. `d[:a]` KeyErrors post-load. **Fix:** treat Dicts with
  any non-String key as non-composite `.jls` leaves (same rule as
  NamedTuples) — also fixes B2.

- [x] **M7 — FIXED 2026-07-17**: both rescues now
  `sprint(showerror, err, catch_backtrace())` (message points at the failing
  file:line in the user's script) and rethrow InterruptException — including
  unwrapping include's LoadError(InterruptException). Tests assert the
  backtrace mentions the script file and that interrupts surface unchanged
  from both the include and run() paths. Original finding —
  `pdv-julia/src/script_exec.jl:355–371`: both catch
  blocks rebuild errors as `PDVScriptError(sprint(showerror, err))`,
  discarding the backtrace (no file/line in the user's script; Python chains
  the full traceback) and swallowing InterruptException (interrupt during a
  script run mislabeled a script error). **Fix:**
  `bt = catch_backtrace(); err isa InterruptException && rethrow();
  sprint(showerror, err, bt)` in both blocks.

- [x] **M8 — FIXED 2026-07-17**: new exported `sanitizedJuliaEnv()` strips
  `JULIA_PROJECT`/`JULIA_LOAD_PATH`; applied to `installPDVKernel`,
  `probeJuliaRuntime`, and `checkJuliaPDVInstalled` (audit: juliaup spawns
  don't consult these; julia-env sets `--project` explicitly; kernel spawns
  deliberately honor the user's export). Stub-level test proves the vars
  don't leak into the spawned process. Original finding —
  `electron/main/julia-discovery.ts:596–613`:
  `installPDVKernel` spawns with `{...process.env}` and no
  `--project`/`Pkg.activate`; a shell-exported `JULIA_PROJECT` (common for
  cluster users) redirects `Pkg.develop`/`Pkg.add("IJulia")` **into the
  user's own Project.toml** (the §10.6.1/§10.5.7 forbidden mutation) while
  badges report success. **Fix:** strip `JULIA_PROJECT`/`JULIA_LOAD_PATH`
  from the spawn env or `Pkg.activate` the `v<major.minor>` default env
  explicitly. (Check the probe + juliaup spawns for the same exposure.)

- [x] **M9 — FIXED 2026-07-17**: `pendingProjectRef` recover entries now
  carry their language; the consume effect drops any entry whose language
  doesn't match the kernel that actually came up (open entries too); the
  ref is cleared on `kernelStatus === 'error'` and on the launch overlay's
  Cancel. Original finding — `electron/renderer/src/app/index.tsx:1398–1434`:
  `pendingProjectRef` set before `ensureKernel(language)` is never cleared on
  launch failure/cancel (`useKernelLaunch.ts:171–174` only resets the
  overlay) and the consume effect ignores language. Scenario: recover a
  [Julia] autosave → boot fails (no PDVKernel) → Cancel → New Python Project
  → stale entry fires `executeRecoverUnsaved(juliaOrphanDir)` into the Python
  kernel. **Fix:** clear the ref on launch failure/cancel, or store the
  required language and drop on mismatch at consume time.

## Minors

- [ ] `electron/main/julia-env.ts:128–168` + `ipc-register-kernels.ts:713`
  (CONFIRMED): `instantiateJuliaEnvironment` has no timeout/idle deadline and
  is awaited under the start lock — a hung `Pkg.instantiate` wedges the
  overlay AND all later start/stop/restart until app relaunch. Apply the
  §10.8 idle-deadline pattern.
- [ ] `ipc-register-kernels.ts:984–1024` (CONFIRMED): restart pkg fallback
  never calls `abortInstantiate` when relaunch fails (start handler does,
  :706) — orphaned instantiate streams stale envActivity forever.
- [ ] `electron/main/project-manager.ts:327–352, 462–470` (CONFIRMED):
  `failed_nodes` never reach the UI (console.warn only) and the
  kernel-initiated `pdv.project.save_completed` cache has no failed_nodes
  field — a save that skipped nodes is indistinguishable from complete.
  Plumb through `ProjectSaveResult` (mirror missing_files). Amplifies M1.
- [ ] `julia-discovery.ts:242–245` (CONFIRMED): shim-bypass fallback requires
  `isDefault && version !== null` — a **linked** default channel
  (`juliaup link`, version null) defeats the bypass → kernel spawns through
  julialauncher. Use the linked channel's Command path.
- [ ] `electron/main/index.ts:698–704` (CONFIRMED): `syncPkgEnvironmentForLoad`
  runner falls back to `juliaPath ?? "julia"` without `resolveJuliaShim` —
  last remaining spawn site that can hit the shim (and no timeout).
- [ ] `pdv-julia/src/handlers/tree.jl:348–350` + `tree.jl:531–537`
  (CONFIRMED, BOTH kernels): rename/move of a sequence child makes
  `set_quiet!` replace the whole Vector with an empty PDVTree holding only
  the renamed child, and Julia replies `renamed: true`. Renderer suppresses
  via parent_is_opaque; **MCP agent tools do not**. Reject rename/move when
  the parent isn't key-addressable (both kernels).
- [ ] `pdv-julia/src/script_exec.jl:276–284` (CONFIRMED): issue-17
  "lossless-only" coercion is false above 2^53 (Float32: 2^24) — big Int vs
  `::Float64` silently rounds. Add round-trip guard; fix
  JULIA_KNOWN_ISSUES #17 wording.
- [ ] `pdv-julia/src/query_cache.jl:52–62` (CONFIRMED): snapshot walk has no
  cycle guard — self-referential Dict recurses to the 50k cap/StackOverflow
  every rebuild, snapshot permanently stale. Mirror checksum.jl's IdDict
  visited-set.
- [ ] `pdv-julia/src/serialization.jl:158–176` (CONFIRMED): inline-JSON admits
  any in-range Integer/finite AbstractFloat — `Int32`/`Float32`/`UInt64`
  scalars, `BitVector`, `Vector{String}` reload as `Int64`/`Float64`/
  `Vector{Any}` with an UNCHANGED digest (checksum feeds width-insensitively,
  checksum.jl:228–236). Document in §5.14 or route non-Int64/Float64/Bool
  scalars to .jls.
- [ ] `pdv-julia/src/handlers/project.jl:418` + `checksum.jl:138` (PLAUSIBLE):
  post-index `tree_checksum` runs outside any rescue and the last-resort
  `repr` is unguarded (OffsetInteger precedent) — a failure there reports
  serialization_error AFTER the index was rewritten and orphans purged,
  `project.json` left stale. Guard the repr fallback.
- [ ] `pdv-julia/src/namespace.jl:23` (CONFIRMED): `include_private=true` is a
  dead wire option on Julia — `namespace_bindings()` pre-drops `_`-prefixed
  bindings.
- [ ] `pdv-julia/src/tree.jl:361, 396` (PLAUSIBLE): user `Threads.@spawn`
  writing pdv_tree from a default thread races the main-thread snapshot
  rebuild's live Dict walk (no GIL; mid-rehash reads can crash). Document the
  constraint or funnel setindex! through a lock shared with the walk.
- [ ] `NewJuliaProjectDialog/index.tsx:60, 90, 112` (CONFIRMED): render gate
  `juliaupInstalled !== false` vs `handleCreate` sending
  `juliaupInstalled ? juliaVersion : undefined` — fast Create while the probe
  is in flight silently drops the displayed version; `Promise.all` has no
  `.catch` (stuck-null + unhandled rejection).
- [ ] `EnvironmentSelector/index.tsx:883–925` (CONFIRMED): the three Julia
  install flows (juliaup add / Install PDVKernel / Install juliaup) aren't
  mutually exclusive and interleave on one onInstallOutput channel; two
  Pkg/juliaup subprocesses can mutate the same depot concurrently. Single
  shared busy flag.
- [ ] `app/index.tsx:1462` (PLAUSIBLE): pkg-mode launch failures withhold the
  "Choose environment…" overlay action (`mode === 'shared'` gate) though the
  commonest pkg failure (missing PDVKernel) is a runtime-selection error;
  Retry re-fails identically.
- [ ] `project-file-sync.ts:417–421` + ipc-register-project (PLAUSIBLE):
  loading a legacy shared Julia save into a live pkg session leaves the
  previous project's env files in the working dir; working-dir-based
  `isPkgProject` then stamps the legacy project `mode:"pkg"` and copies the
  foreign Project.toml into its save dir on next save. Manifest-based guard.
- [ ] Docs drift (CONFIRMED): ARCHITECTURE §10.6.2 (~line 1758) still says
  juliaup version acquisition "is future work" (contradicts §10.7.5/shipped
  code); §5.14 query-server row documents the B1 design (update with B1 fix);
  JULIA_KNOWN_ISSUES #17 "lossless" wording false (see minor above);
  pre-existing §7.3 `lazy`-field drift (not this PR).
- [ ] `electron/main/kernel-manager.ts:1062–1083` (CONFIRMED):
  `isExecutionActive` inserted between `onIopubMessage`'s JSDoc and the
  function — orphaned doc block (§13).
- [ ] **Pre-existing, both backends (track, not a PR defect):** namelist
  editor's JS JSON boundary collapses `1.0` → `1`; untouched save retypes
  real fields as int and next session's parseInt coercion turns `0.5` into
  `0`. `NamelistEditor.tsx` + Python handler untouched by this PR. Add to
  JULIA_KNOWN_ISSUES or a repo issue alongside the M5 fix.

## Claims the reviewer could not verify

- e2e suites (Julia tour 21, makie-save 6/6, Python boot re-runs) — needs
  build:e2e + warm caches; not re-run by the reviewer.
- "2–7 ms replies mid-computation" latency figure (test only asserts <2 s) —
  and B1 supersedes it anyway.
- "Zero added wall-clock warm" instantiate/boot overlap (unmeasured).
- #20 heal against real interrupted GPEC runs (re-validate after M3 fix).
- Mutating juliaup flows against a real network (bootstrap script, add).
- MCP agent tools on a Julia kernel (acknowledged gap; sequence-rename minor
  is reachable exactly there).

## Suggested fix order (proposed to Matt 2026-07-17)

B1 (+ busy-kernel `@threads :static` re-validation) → B2+M1+M6 (one coherent
save-walker fidelity pass) → M2 → M3 → B3 → M4 → M5 → M7 → M8/M9 → minors +
docs drift sweep.
