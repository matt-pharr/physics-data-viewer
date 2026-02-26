# Feature 2 Progress

## Completed

### Step 1 — Add module domain types and IPC surface

Implemented end-to-end typed scaffolding for `window.pdv.modules.*` with placeholder behavior:

- Added module IPC channels in `electron/main/ipc.ts`:
  - `modules:listInstalled`
  - `modules:install`
  - `modules:checkUpdates`
  - `modules:importToProject`
  - `modules:listImported`
  - `modules:saveSettings`
  - `modules:runAction`
- Added module request/response/domain types in `electron/main/ipc.ts`:
  - install source/descriptor types
  - install/update/import/settings/action payload/result types
- Mirrored module API/types in `electron/renderer/src/types/pdv.d.ts`.
- Exposed new typed API methods in `electron/preload.ts` under `window.pdv.modules`.
- Registered module IPC handlers in `electron/main/index.ts` with explicit Step-1 placeholder responses (`not_implemented`) and included the new channels in unregister bookkeeping.
- Added tests in `electron/main/index.test.ts` covering placeholder module handlers:
  - `modules:listInstalled` returns `[]`
  - `modules:install` returns `status: "not_implemented"`

### Step 2 — Implement `ModuleManager` in Electron main

Implemented `electron/main/module-manager.ts` and wired real install/list behavior for module IPC:

- Added new `ModuleManager` with store layout under `<pdvDir>/modules`:
  - packages root: `<pdvDir>/modules/packages`
  - metadata index: `<pdvDir>/modules/index.json`
- Implemented module install flows:
  - local source install (copy + manifest validation + indexed metadata write)
  - GitHub source install (git clone + revision capture + metadata write)
- Implemented strict `pdv-module.json` validation in manager:
  - required `schema_version`, `id`, `name`, `version`
  - required `actions[]` entries with `id`, `label`, `script_path`
- Implemented deterministic `listInstalled()` from metadata index (sorted output).
- Wired IPC handlers in `electron/main/index.ts`:
  - `modules:listInstalled` now delegates to `ModuleManager.listInstalled()`
  - `modules:install` now delegates to `ModuleManager.install()`
  - `modules:checkUpdates` now delegates to `ModuleManager.checkUpdates()` (currently `not_implemented` update check status in v1 scaffold).
- Updated IPC handler tests (`electron/main/index.test.ts`) to mock/delegate through `ModuleManager`.
- Added `electron/main/module-manager.test.ts` covering:
  - local install + list
  - idempotent local reinstall (`up_to_date`)
  - invalid manifest error path
  - git-backed install and revision capture

### Step 3 — Implement install/update semantics

Implemented explicit duplicate-install/update-state behavior in `ModuleManager`:

- Added explicit duplicate outcomes in install status types:
  - `up_to_date`
  - `update_available`
  - `incompatible_update`
- Updated shared IPC and renderer type contracts to include `incompatible_update`.
- Changed duplicate install behavior to **not overwrite** existing installed module files silently:
  - For duplicate install attempts, the manager now computes and returns explicit state.
  - Existing installed module remains unchanged until a future explicit update-confirm flow is added.
- Added version-aware duplicate checks:
  - same version/revision => `up_to_date`
  - different version/revision (same major) => `update_available`
  - major-version change => `incompatible_update`
- Extended module index history tracking with explicit `update_check` entries for troubleshooting.
- Added Step 3 tests in `electron/main/module-manager.test.ts`:
  - duplicate install with newer same-major version => `update_available`
  - duplicate install with major version change => `incompatible_update`
  - verifies installed baseline version remains unchanged after duplicate update-check results

### Step 4 — Extend project manifest for module imports/settings

Implemented project manifest extension groundwork in `ProjectManager` with backward-compatible defaults:

- Extended `ProjectManifest` (`electron/main/project-manager.ts`) with:
  - `modules: ProjectModuleImport[]`
  - `module_settings: Record<string, Record<string, unknown>>`
- Updated project schema version to `1.1` for the additive manifest expansion.
- Updated save path (`ProjectManager.save`) so written `project.json` includes:
  - `modules: []`
  - `module_settings: {}`
- Updated `ProjectManager.readManifest()` parsing:
  - old manifests missing these fields default to empty values
  - provided `modules` and `module_settings` fields are validated and parsed
  - malformed values produce explicit errors
- Added/updated tests in `electron/main/project-manager.test.ts`:
  - save writes `modules` + `module_settings` defaults
  - readManifest defaults missing fields for old schema files
  - readManifest parses populated `modules` + `module_settings` payloads

### Step 5 — Add project import workflow

Implemented project-scoped module import persistence and conflict-safe alias handling in main IPC:

- Implemented `modules.importToProject` in `electron/main/index.ts`:
  - requires active project context (`project.load` or `project.save`)
  - resolves installed module by id from `ModuleManager`
  - persists import entry into `project.json` (`modules` array)
  - sends a tree-changed push to refresh renderer tree state
- Implemented alias normalization + conflict flow:
  - normalized alias values (`.`/whitespace/path separators -> `_`)
  - detects duplicate aliases in project manifest
  - returns `status: "conflict"` with suggested alias (`name_1` pattern)
- Implemented `modules.listImported`:
  - reads active project manifest imports
  - enriches display name from installed module metadata when available
  - returns typed imported module descriptors to renderer
- Tracked active project path in IPC registration lifecycle:
  - `project.load` and `project.save` set active project dir
  - `project.new` clears active project dir
- Added IPC tests (`electron/main/index.test.ts`) for:
  - alias conflict result with suggested alias
  - successful import persistence to `project.json`
  - imported module listing for active project

### Step 6 — Bind imported module scripts into `pdv_tree`

Implemented script-tree binding for imported modules with idempotent rebind behavior:

- Added `ModuleManager.resolveActionScripts(moduleId)` in `electron/main/module-manager.ts`:
  - validates installed module exists
  - reads and validates `pdv-module.json` actions
  - resolves canonical script bindings (`name` + absolute `scriptPath`)
  - validates referenced script files exist
  - generates stable unique node names (`run`, `run_1`, …) for basename collisions
- Added binding helpers in `electron/main/index.ts`:
  - bind one module import to `<alias>.scripts.<scriptName>`
  - bind all imported modules for active project
- Binding is now invoked:
  - after kernel start/restart (when an active project exists)
  - after project load (when an active kernel exists)
  - immediately after successful module import (when active kernel exists)
- Script registration uses `reload: true`, making repeat binds idempotent and safe.
- Added tests:
  - `module-manager.test.ts` covers canonical action-script binding resolution
  - `index.test.ts` verifies import/load trigger script registration into expected tree paths

### Step 7 — Build Modules pane foundation in renderer

Replaced the placeholder Modules view with a functional foundation UI:

- Added `ModulesPanel` component (`electron/renderer/src/components/ModulesPanel/index.tsx`) with:
  - Library section: refresh, install-local, install-github, installed module list
  - Import actions for installed modules via `window.pdv.modules.importToProject`
  - Conflict handling prompt using suggested alias retry flow
  - Imported modules section rendered as one tab per imported module
- Wired panel into app root (`renderer/src/app/index.tsx`) replacing:
  - `Modules view (coming soon)` placeholder
- Added renderer styling for modules UI in `renderer/src/styles/index.css`.
- Updated renderer type barrel exports (`renderer/src/types/index.ts`) for module types used by the panel.

### Step 8 — Declarative module controls and action execution

Implemented manifest-driven action controls and execution wiring for imported modules:

- Extended imported-module IPC payloads with declarative action metadata:
  - Added `ImportedModuleActionDescriptor` to shared contracts
  - `modules.listImported` now returns per-module actions (`id`, `label`, `scriptName`)
- Extended action-script binding metadata in `ModuleManager.resolveActionScripts()`:
  - each resolved binding now carries source action identity (`actionId`, `actionLabel`) plus canonical script node name
- Implemented `modules.runAction` in `electron/main/index.ts`:
  - validates active project, kernel id, imported module alias, and action id
  - resolves action id to canonical script node name from module manifest/bindings
  - builds and returns `executionCode` for `pdv_tree["<alias>.scripts.<name>"].run(...)`
- Updated renderer `ModulesPanel` to render declarative per-action controls:
  - one action row per imported module action
  - optional JSON-object params input per action
  - run button invokes `window.pdv.modules.runAction(...)` then executes returned code via app-level `handleExecute`
  - action errors/statuses surfaced in panel, execution output remains in existing Console flow
- Updated app wiring (`renderer/src/app/index.tsx`) to pass kernel state and execute callback to `ModulesPanel`.
- Updated tests:
  - `main/index.test.ts` verifies `modules.listImported` action descriptors and `modules.runAction` execution code generation
  - `main/module-manager.test.ts` verifies resolved bindings include action identity metadata

### Step 9 — Persist per-module settings

Implemented project-backed settings persistence for module action controls:

- Extended imported-module descriptors with `settings` so renderer can hydrate persisted control values.
- Implemented `modules.saveSettings` in `electron/main/index.ts`:
  - validates active project context and imported module alias
  - persists `module_settings[moduleAlias]` through `ProjectManager.saveManifest`
- Extended `modules.listImported` to include per-alias settings from `project.json` `module_settings`.
- Updated `ModulesPanel` to persist and hydrate action parameter drafts:
  - loads saved values into action inputs on refresh/tab display
  - saves per-action settings on input blur and before action run
  - preserves existing action execution path through app console logging
- Updated tests in `electron/main/index.test.ts`:
  - listImported includes `settings`
  - saveSettings persists updated `module_settings` content

### Step 10 — Health checks and warning surfacing

Implemented non-blocking module health validation and warning display:

- Extended module manifest parsing in `ModuleManager` to accept optional:
  - `compatibility` (`pdv_min`/`pdv_max`, `python`, `python_min`/`python_max`)
  - `dependencies` (`name`, optional `version`, optional `marker`)
- Added `ModuleManager.evaluateHealth(moduleId, context)`:
  - evaluates PDV compatibility range warnings
  - evaluates Python compatibility range warnings
  - emits warning-only dependency requirement notices (v1 no auto-validation/install)
  - detects missing/non-file action script paths as warnings
- Added warning-tolerant tree binding behavior for missing scripts:
  - missing action script paths no longer block bind/load/import flows
  - structurally invalid manifests still throw
- Extended IPC types and payloads:
  - new `ModuleHealthWarning` contract
  - `ImportedModuleDescriptor.warnings`
  - optional `ModuleImportResult.warnings`
- Added import/load-time warning evaluation in main IPC:
  - project load refreshes module warnings
  - import returns immediate warning list for imported alias
- Updated Modules UI to surface warnings:
  - warning count badge on module tabs
  - warning list in selected module tab content
  - import status includes warning count when present
- Updated tests:
  - `main/module-manager.test.ts` verifies compatibility/dependency/missing-script warnings
  - `main/index.test.ts` verifies import/list warning behavior and missing-script non-blocking flow

### Step 11 — UX for duplicate imports and updates

Implemented duplicate/import update UX improvements in the Modules panel:

- Improved duplicate import conflict prompt text to include current alias and suggested alias.
- Added clearer cancel status messaging for duplicate import conflict flow.
- Added update-state prompt UX for duplicate installs:
  - when install returns `update_available` / `incompatible_update`, UI now shows current vs available version/revision context in a confirmation dialog
  - flow remains non-destructive (no silent overwrite; no auto-apply update)
- Added status badges in the Library list:
  - `installed`
  - `imported` (with multiplicity count when imported multiple times)
  - `warning` (aggregated warning count from imported aliases)
  - `update available` / `incompatible update` from recent install status
- Updated import action button label to `Import Again` when module already imported in active project.

## Verification

- Baseline tests before changes:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Tests after Step 1 scaffolding:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Targeted tests for Step 2:
  - `cd electron && npm test -- --reporter=verbose main/module-manager.test.ts main/index.test.ts` (passed)
- Full tests after Step 2 wiring:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Targeted tests after Step 3 semantics:
  - `cd electron && npm test -- --reporter=verbose main/module-manager.test.ts main/index.test.ts` (passed)
- Full tests after Step 3:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Targeted tests after Step 4 manifest changes:
  - `cd electron && npm test -- --reporter=verbose main/project-manager.test.ts main/module-manager.test.ts main/index.test.ts` (passed)
- Full tests after Step 4:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Targeted tests after Step 5 import workflow:
  - `cd electron && npm test -- --reporter=verbose main/index.test.ts main/project-manager.test.ts main/module-manager.test.ts` (passed)
- Full tests after Step 5:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Targeted tests after Step 6 binding changes:
  - `cd electron && npm test -- --reporter=verbose main/module-manager.test.ts main/index.test.ts` (passed)
- Full tests after Step 6:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Full tests after Step 7 renderer foundation:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Full tests after Step 8 controls/action wiring:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Full tests after Step 9 settings persistence:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Full tests after Step 10 health checks/warnings:
  - `cd electron && npm test -- --reporter=verbose` (passed)
- Full tests after Step 11 duplicate/update UX:
  - `cd electron && npm test -- --reporter=verbose` (passed)

## Next

- Step 12 — Expand automated coverage for remaining module flows.
