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

## Next

- Step 8 — Render declarative per-module UI controls and execute module actions from those controls.
