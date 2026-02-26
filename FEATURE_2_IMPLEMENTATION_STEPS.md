# Feature 2 Implementation Steps — Modules System

## 0) Scope and vision (confirmed)

This plan implements **Feature 2: Modules System** from `PLANNED_FEATURES.md` with the following confirmed product decisions:

1. **Install vs import model**
   - Modules are first **installed** into a shared local module store.
   - Modules are then **imported per-project** (project-scoped activation).
2. **Install sources in v1**
   - Support **GitHub repository URL** and **local folder path**.
   - No central remote registry service in v1.
3. **UI model in v1**
   - Modules tab becomes real UI.
   - Each imported module gets its **own tab** in the Modules pane.
   - Module UI is **declarative manifest-driven** (no arbitrary frontend plugin code).
4. **Action execution model**
   - Actions are bound to Python scripts and invoked from module UI controls.
   - Imported module scripts must also be callable directly through tree paths, e.g.
     `pdv_tree['AAAAA.scripts.script1'].run(var1=5, var2="hello")`.
5. **Dependency handling in v1**
   - Perform version-aware validation and warnings only.
   - No automatic dependency installation yet.
6. **Duplicate handling**
   - Install existing module => perform update check flow.
   - Importing a module already imported in project => prompt to import as `name_1` or cancel.


## 1) Non-goals for v1

- Remote module registry service.
- Arbitrary module-supplied frontend code execution.
- Automatic conda/uv/pip environment creation/management.
- Full trust/signing model (tracked under Feature 9).


## 2) Architecture additions (high level)

Implement three layers:

1. **Global Module Store (Electron main process)**
   - Source acquisition (`git clone/fetch` or local copy/symlink strategy).
   - Installed version metadata and update checks.
2. **Project Module Imports (project manifest + kernel tree binding)**
   - Which modules are active in this project.
   - Import alias, pinned version/revision, per-module settings.
3. **Renderer Modules Experience**
   - Modules library/install/import UX.
   - One tab per imported module.
   - Declarative controls rendered from manifest; actions invoke scripts.


## 3) Data contracts to define first

### 3.1 `pdv-module.json` v1 schema

Define and validate a strict schema with at least:

- `schema_version`
- `name`, `id`, `version`, `description`
- `source` metadata (repo URL / local source)
- `compatibility`:
  - `pdv_min`, `pdv_max` (or semver range)
  - `python` version range
- `dependencies` list (name + version range + optional marker)
- `actions`:
  - `id`, `label`, `script_path`
  - optional parameter defaults and metadata
- `ui` (declarative):
  - sections/groups
  - buttons
  - menus/dropdowns
  - parameter forms and control-to-action bindings

### 3.2 `project.json` extension (ProjectManifest v1.1)

Extend `ProjectManager` manifest with:

- `modules`: array of imported module descriptors:
  - module id/name
  - import alias in tree
  - installed version/revision
  - action/script bindings resolved at import time
- `module_settings`: persisted per-module UI parameter values.

Back-compat requirements:

- Missing `modules` / `module_settings` must load as empty defaults.
- Existing projects without modules must continue to load/save unchanged.


## 4) Step-by-step implementation plan

### Step 1 — Add module domain types and IPC surface

1. Add module-related request/response types to `electron/main/ipc.ts`.
2. Add IPC channels for:
   - list installed modules
   - install module (GitHub URL / local path)
   - check updates
   - import module into project
   - list imported modules for active project
   - save module settings
   - run module action (or pass-through helper payload)
3. Mirror types in `electron/renderer/src/types/pdv.d.ts`.
4. Expose APIs in `electron/preload.ts`.
5. Register handlers in `electron/main/index.ts`.

**Exit criteria:** typed `window.pdv.modules.*` API exists end-to-end with placeholder implementations.


### Step 2 — Implement `ModuleManager` in Electron main

1. Create `electron/main/module-manager.ts` with:
   - install root under app data (e.g. `<userData>/modules`)
   - metadata index for installed modules.
2. Implement install from GitHub:
   - clone if missing
   - fetch/pull/check revision if already installed.
3. Implement install from local path:
   - copy or tracked mirror strategy.
4. Parse and validate `pdv-module.json`.
5. Return normalized module descriptors to renderer.

**Exit criteria:** modules can be installed/listed with deterministic metadata and schema validation.


### Step 3 — Implement install/update semantics

1. If install target matches existing module id/name:
   - treat as update check flow.
2. Compute version/revision delta and expose status:
   - up-to-date / update available / incompatible update.
3. Keep installed history metadata for troubleshooting.

**Exit criteria:** duplicate install attempts never silently overwrite; user gets explicit update state.


### Step 4 — Extend project manifest for module imports/settings

1. Update `ProjectManifest` in `electron/main/project-manager.ts`:
   - include `modules` and `module_settings`.
2. Update save/load read/write logic with defaults and migration behavior.
3. Add tests in `electron/main/project-manager.test.ts` for:
   - new fields persisted
   - old manifests still parse
   - missing fields default correctly.

**Exit criteria:** per-project module activation and settings persist in `project.json`.


### Step 5 — Add project import workflow

1. Implement `importModuleToProject(project, moduleId, alias?)`.
2. Enforce duplicate import behavior:
   - if alias already exists, return conflict status and suggested alias (`name_1` pattern).
3. Persist import result into project manifest.
4. Trigger tree binding refresh for imported module.

**Exit criteria:** module import is project-scoped, conflict-safe, and persisted.


### Step 6 — Bind imported module scripts into `pdv_tree`

1. Define canonical tree mapping for imports:
   - `<moduleAlias>.scripts.<scriptName>`
2. Ensure scripts are represented as PDV script nodes so existing run/edit/reload flows work.
3. Ensure direct invocation path works exactly as requested:
   - `pdv_tree['<alias>.scripts.<name>'].run(...)`
4. Ensure binding is idempotent across reloads/import repeats.

**Exit criteria:** imported module scripts appear in tree and run through existing script execution path.


### Step 7 — Build Modules pane foundation in renderer

1. Replace placeholder in `renderer/src/app/index.tsx` with real modules container.
2. Add "Library" section for install/list/update/import actions.
3. Render one tab per imported module.
4. Wire to `window.pdv.modules.*` APIs and error states.

**Exit criteria:** users can install + import modules through UI and switch module tabs.


### Step 8 — Render declarative per-module UI controls

1. Implement manifest-driven control renderer:
   - button controls
   - menu/dropdown controls
   - parameter forms.
2. Map controls to action definitions.
3. Execute action by constructing call to bound script node with parameters.
4. Surface execution/log errors in existing console/error UX.

**Exit criteria:** imported module tab can execute actions purely from declarative manifest controls.


### Step 9 — Persist per-module settings

1. Store control values and module preferences in project manifest `module_settings`.
2. Load settings when project opens.
3. Apply saved values to module tabs/forms before first action execution.

**Exit criteria:** module configuration state survives save/reload of project.


### Step 10 — Health checks and warnings

1. At project open and module import:
   - validate PDV compatibility range
   - validate Python version range
   - validate dependency version requirements (warn-only)
   - validate each action script path exists.
2. Expose warning status per module in Modules UI.
3. Ensure warnings are non-blocking in v1 unless manifest is structurally invalid.

**Exit criteria:** users see actionable module health status; no silent breakage.


### Step 11 — UX for duplicate imports and updates

1. Import conflict prompt:
   - "`module X` already imported. Import as `X_1`?"
2. Update prompt when install target already exists:
   - show current vs available version/revision.
3. Add user-facing status badges:
   - installed, imported, warning, update available.

**Exit criteria:** duplicate and update flows are explicit and user-controlled.


### Step 12 — Automated testing

1. **Main process unit tests**
   - module manager install/update/validation paths
   - IPC handlers for modules channels
   - project manifest module persistence.
2. **Python tests**
   - module tree binding helpers
   - action script resolution
   - health check helpers.
3. **Integration tests**
   - install module -> import -> action run -> save project -> reload -> action still works.

**Exit criteria:** new module flows have deterministic test coverage across main + kernel integration points.


### Step 13 — Documentation updates

1. Update `ARCHITECTURE.md`:
   - remove "Modules tab placeholder" status
   - document new module install/import architecture and contracts.
2. Update `PLANNED_FEATURES.md` progress notes for Feature 2 subitems.
3. Add user docs for:
   - install from GitHub/local
   - import into project
   - module tab usage
   - health warnings and dependency expectations.

**Exit criteria:** architecture + user guidance match implemented behavior.


### Step 14 — Manual acceptance checklist

A release candidate for Feature 2 is ready when all are true:

1. Install module from GitHub URL succeeds and module appears in library.
2. Re-install same module triggers update check flow, not duplicate install.
3. Install module from local path succeeds.
4. Import installed module into project creates module tab and tree subtree.
5. Duplicate import prompts rename suggestion and honors user choice.
6. Clicking module UI actions executes bound scripts and logs output/errors.
7. Direct tree invocation (`pdv_tree['alias.scripts.script'].run(...)`) works.
8. Save project and reopen restores imported modules + module settings.
9. Missing script/dependency/version mismatch shows warnings (non-silent).
10. Existing non-module projects still open/save with no regressions.


## 5) Recommended implementation order (execution sequence)

1. Steps 1–3 (contracts + module manager + update semantics)
2. Step 4 (project manifest extension)
3. Steps 5–6 (import and tree binding)
4. Steps 7–9 (UI and settings persistence)
5. Steps 10–11 (health checks and UX polish)
6. Steps 12–14 (tests, docs, release validation)


## 6) Open items to defer (not blockers for v1)

- Automatic dependency/environment provisioning (conda/uv integration).
- Private repo auth UX and credential management strategy.
- Module signing/trust policy enforcement (Feature 9 integration).
- Remote registry/discovery service beyond direct GitHub URLs.
