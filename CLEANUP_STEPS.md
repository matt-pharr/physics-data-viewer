# CLEANUP_STEPS

This document gives **execution-ready instructions for an AI coding agent** to finish missing parts of Steps 6/7/8 and clean up the duplicate/zombie/poor-quality areas identified in `CURRENT_STATE.md`.

## Scope and constraints
- **In scope**
  - Finish missing functionality for **Step 6 (plot mode hardening)**, **Step 7 (namespace interactions)**, **Step 8 (script reload + file watch)**.
  - Remove duplicate/zombie code identified in `CURRENT_STATE.md`.
  - Rework maintainability hotspots explicitly called out in `CURRENT_STATE.md`.
- **Out of scope for this cleanup pass**
  - Step 9+ features (data loaders, object store, module manifests, packaging, etc.).
  - Broad refactors that change behavior beyond steps 6/7/8 and listed cleanup items.

**Current policy note:** Python functionality is prioritized; Julia functionality should be treated as deferred/stubbed until Python feature completeness is achieved.

---

## Non-negotiable working rules for the implementing agent
1. Keep changes incremental and small; commit/report progress per phase.
2. Run `npm run build` + `npm test` in `/home/runner/work/physics-data-viewer/physics-data-viewer/electron` after each phase.
3. Preserve direct-ZMQ architecture (no migration to `@jupyterlab/services`).
4. Keep IPC contract types synchronized across main/preload/renderer.
5. Do not begin Step 9+ work while this cleanup plan is incomplete.

---

## Phase 0 — Baseline and branch hygiene

### Tasks
1. In `/home/runner/work/physics-data-viewer/physics-data-viewer/electron`:
   - `npm install`
   - `npm run build`
   - `npm test`
2. Record current status and failing tests (if any) before code edits.

### Acceptance criteria
- Baseline build/test status is known and documented in progress report.

---

## Phase 1 — Remove duplicate/zombie code first (low risk)

**Status:** ✅ Complete

### 1A) Eliminate duplicate IPC channel constant definitions

### Why
`CURRENT_STATE.md` identifies duplicated IPC channel names in `preload.ts` vs `main/ipc.ts`.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/ipc.ts`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/preload.ts`

### Instructions
1. Make `preload.ts` use shared IPC constants instead of a local duplicated `const IPC` map.
2. Keep preload import runtime-safe (only import constants/types that do not require Electron main APIs).
3. Ensure no channel string changes.

### Acceptance criteria
- No duplicated channel-constant block remains in `preload.ts`.
- TypeScript build passes.
- Existing renderer calls still work unchanged.
- **Completed:** ✅ (later adjusted to retain local preload IPC map for startup stability after GUI regression)

---

## 1B) Remove confirmed unused function in Tree component

### Why
`applyExpandedState(...)` in `Tree/index.tsx` is dead code per `CURRENT_STATE.md`.

### File target
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/renderer/src/components/Tree/index.tsx`

### Instructions
1. Remove the unused function and any dead imports/types only associated with it.
2. Do not alter tree behavior in this task.

### Acceptance criteria
- Function is removed.
- Tree component tests still pass.
- **Completed:** ✅

---

## 1C) Remove unused dependencies (if confirmed by code search)

### Why
`CURRENT_STATE.md` flags likely-unused dependencies: `@jupyterlab/services`, `ws`.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/package.json`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/package-lock.json`

### Instructions
1. Confirm with repository-wide search that these packages are not imported at runtime/tests.
2. If unused, remove from dependencies and run `npm install` to regenerate lockfile.
3. If one is still needed anywhere, keep it and note rationale in progress report.

### Acceptance criteria
- Dependency list reflects actual usage.
- Build/test unchanged.
- **Completed:** ✅ (`@jupyterlab/services` and `ws` removed after usage search)

---

## Phase 2 — Complete missing Step 8 behavior (scripts + watch)

**Status:** ✅ Complete

### 2A) Implement real `script:reload`

### Why
`IPC.script.reload` currently returns success without doing reload work.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/index.ts`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/init/python-init.py`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/init/julia-init.jl`

### Instructions
1. Implement real reload behavior in main IPC handler:
   - Resolve script path via existing scanner/path logic.
   - Execute a kernel-side helper that invalidates/refreshes script module state.
2. Add explicit helper(s) in init scripts for Python/Julia reload semantics.
3. Return structured result `{ success, error? }` with meaningful error text.

### Acceptance criteria
- Reloading a modified script changes subsequent run behavior without app restart.
- Reload failures (syntax/path errors) return actionable messages.
- **Completed:** ✅

---

## 2B) Implement file watch/unwatch IPC handlers

### Why
`files.watch` and `files.unwatch` are stubs returning `false`.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/index.ts`
- (optional helper module if extracted) under `electron/main/`

### Instructions
1. Implement real watcher registration using Node filesystem watching.
2. Keep watcher map keyed by watched path; support unwatch and cleanup.
3. Prevent duplicate watcher leaks on repeated watch calls.
4. Ensure cleanup on app quit and kernel restart where relevant.

### Acceptance criteria
- `files.watch` returns `true` for active watches.
- `files.unwatch` returns `true` when watcher is removed.
- No leak from repeated watch/unwatch cycles.
- **Completed:** ✅

---

## Phase 3 — Complete missing Step 6 behavior (plot mode hardening)

### 3A) Harden plot capture handling in kernel pipeline

### Why
Plot plumbing exists but Step 6 is still partial.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/kernel-manager.ts`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/init/python-init.py`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/init/julia-init.jl`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/renderer/src/components/Console/index.tsx`

### Instructions
1. Ensure IOPub handling correctly captures and forwards plot-related outputs for execution result boundaries.
2. Validate capture-mode behavior end-to-end for both Python and Julia helpers.
3. Ensure native mode still works and does not regress command execution.
4. Keep renderer display deterministic when multiple display payloads arrive in one execution.

### Acceptance criteria
- Python capture mode: plot appears inline in console.
- Julia capture mode: plot appears inline in console.
- Native mode remains functional.
- No duplicate/corrupted image rendering on repeated executions.

---

## Phase 4 — Complete missing Step 7 behavior (namespace double-click actions)

### 4A) Add meaningful double-click actions in Namespace view

### Why
Step 7 is partial; current double-click primarily copies variable name.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/renderer/src/components/NamespaceView/index.tsx`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/renderer/src/app/index.tsx`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/index.ts` (if new IPC needed)

### Instructions
1. Implement type-aware double-click actions using available metadata:
   - Arrays/dataframe-like variables -> trigger inspect/preview action.
   - Other variables -> keep copy fallback.
2. Keep UX simple and consistent with existing architecture (avoid large new UI frameworks).
3. Reuse existing kernel execute/inspect pathways where possible.

### Acceptance criteria
- Namespace double-click does more than name copy for inspectable data types.
- Existing search/sort/filter/refresh behavior remains unchanged.

---

## Phase 5 — Rework maintainability hotspots from CURRENT_STATE.md

### 5A) Decompose oversized main-process file(s) without behavior change

### Why
`main/index.ts` and `main/kernel-manager.ts` are large and hard to maintain.

### File targets
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/index.ts`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/kernel-manager.ts`
- New helper modules under `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/`

### Instructions
1. Extract cohesive helper logic and/or handler registration groups into separate files.
2. Keep public behavior and IPC signatures unchanged.
3. Avoid deep architectural rewrite; this is a maintainability split only.

### Acceptance criteria
- Smaller files with equivalent behavior.
- No API/signature regressions.
- Build/tests remain green.

---

## Phase 6 — Tests required for this cleanup

Add or extend targeted tests for each implemented gap.

### Required test coverage
1. **Script reload**
   - Validate changed script output after reload.
2. **File watch/unwatch**
   - Validate watcher registration lifecycle and no-duplicate behavior.
3. **Plot capture**
   - Validate `images` payload generation path for capture mode.
4. **Namespace double-click action routing**
   - Validate UI action behavior for at least one inspectable type.
5. **IPC dedup cleanup safety**
   - Smoke test preload bridge methods still invoke correct channels.

### Existing test locations (prefer reuse)
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/main/*.test.ts`
- `/home/runner/work/physics-data-viewer/physics-data-viewer/electron/renderer/src/services/tree.test.ts`

### Acceptance criteria
- New/updated tests pass locally with existing test runner.
- No unrelated tests are modified or removed.

---

## Phase 7 — Final verification checklist

1. Run in `/home/runner/work/physics-data-viewer/physics-data-viewer/electron`:
   - `npm run build`
   - `npm test`
2. Manual sanity checks:
   - Start app in dev mode, execute code, run/reload script, confirm namespace interaction, confirm plot capture/native behavior.
3. Update docs minimally:
   - Mark Step 6/7/8 capabilities as completed/partial accurately in `IMPLEMENTATION_STEPS.md` (only if now true).

### Completion criteria for this cleanup project
- All Step 6/7/8 missing items listed above are implemented and tested.
- Duplicate/zombie items from `CURRENT_STATE.md` are removed or explicitly justified.
- Maintainability rework is complete without behavior regression.

---

## Decision gates (coordinate with QUESTIONS.md discussions)
If developers have not finalized decisions yet, implement with these default-safe rules:
1. Prefer conservative behavior that avoids destructive automation.
2. For script/file changes, prefer prompting/reload action over automatic re-run.
3. Keep compatibility with current Python-first flow while adding Julia parity where explicitly required.
4. Document any deferred choices in PR notes and keep interfaces extensible.
