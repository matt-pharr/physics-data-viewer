# PDV Modules Feature

This document describes the currently implemented **Modules** feature in PDV: how modules are structured, installed, imported into projects, bound into the tree, and executed.

## What a module is

A module is a directory containing:

- **`pdv-module.json`** — the module manifest (identity, compatibility, scripts listing, files, entry point)
- **`scripts/`** — one or more Python action scripts referenced by `actions[]` in `gui.json` (or in `pdv-module.json` for schema v1/v2)
- **`lib/`** (optional) — importable Python files (`.py`) available to scripts and entry points
- **`gui.json`** (optional) — declarative GUI layout for a module window
- **`inputs/`** (optional) — input files (namelists, data files) declared in the manifest `files` array

See the example module:

- Manifest: [`examples/modules/N-pendulum/pdv-module.json`](examples/modules/N-pendulum/pdv-module.json)
- Action scripts:
  - [`examples/modules/N-pendulum/scripts/solve.py`](examples/modules/N-pendulum/scripts/solve.py)
  - [`examples/modules/N-pendulum/scripts/animate.py`](examples/modules/N-pendulum/scripts/animate.py)
- Library: [`examples/modules/N-pendulum/lib/n_pendulum.py`](examples/modules/N-pendulum/lib/n_pendulum.py)

## Install model (global) vs import model (project-scoped)

PDV separates module lifecycle into two steps:

1. **Install** into a global module store (`~/.PDV/modules/...`), from:
   - a local folder path (implemented), or
   - a GitHub repository URL (scaffolded — UI shows "Coming soon").
2. **Import** an installed module into the current project with a project-local alias.

Installed modules are globally available; imported modules are project-specific.

## Global module store and metadata

The Electron main process manages module storage and metadata:

- Packages root: `<pdvDir>/modules/packages`
- Metadata index: `<pdvDir>/modules/index.json`

Installation validates `pdv-module.json`, copies the full module directory (including `lib/`, `scripts/`, `gui.json`, `inputs/`), and stores normalized metadata (`id`, `name`, `version`, source, revision when available).

## Manifest split (schema v3)

In schema v3, the module manifest is split across two files:

- **`pdv-module.json`** retains identity (`id`, `name`, `version`, `schema_version`), `compatibility`, `scripts`, `files`, `lib`, `entry_point`, and `dependencies`.
- **`gui.json`** holds `inputs`, `actions`, and the declarative `gui` layout. This file is optional — modules without a GUI omit it entirely.

This separation keeps the identity/compatibility manifest lightweight and allows GUI definitions to evolve independently.

## Supported manifest functionality

In schema v3, functionality is split across `pdv-module.json` and `gui.json`.

### `pdv-module.json` (identity manifest)

- Required module identity fields (`schema_version`, `id`, `name`, `version`)
- `description`
- `scripts[]` — informational listing of action scripts: `{ name, path }`
- `files[]` — module-provided input files to copy and register:
  - `name` — tree node name
  - `path` — relative path within the module directory
  - `type` — `"namelist"`, `"lib"`, or `"file"`
- `entry_point` — Python module name to import after `sys.path` setup (e.g. `"n_pendulum"`)
- optional `compatibility` metadata:
  - `pdv_min`, `pdv_max`
  - `python`, `python_min`, `python_max`
- optional `dependencies[]` (warn-only)

### `gui.json` (GUI and interaction manifest)

- `has_gui` — boolean flag
- `actions[]` with:
  - `id`
  - `label`
  - `script_path`
  - optional `inputs` (input IDs consumed by the action)
  - optional `tab` (module-internal UI tab grouping)
- `inputs[]` with declarative controls:
  - `control`: `text`, `dropdown`, `slider`, `checkbox`, `file` (omitting `control` defaults to `text`)
  - `default`, `type`, `label`, `tooltip`
  - grouping: `tab`, `section`, `section_collapsed`
  - conditional visibility: `visible_if` with `{ input_id, equals }`
  - slider metadata: `min`, `max`, `step`
  - file picker mode: `file_mode` (`file`/`directory`)
  - dropdown options:
    - static `options` array of `{ label, value }`
    - dynamic `options_tree_path` (populate from tree children at that path)
- `gui` — declarative layout (see "Module GUI windows" below)

For concrete syntax examples, see the N-pendulum module:

- `pdv-module.json`: [`examples/modules/N-pendulum/pdv-module.json`](examples/modules/N-pendulum/pdv-module.json)
- `gui.json`: [`examples/modules/N-pendulum/gui.json`](examples/modules/N-pendulum/gui.json)

Key patterns demonstrated:
- dropdown with dynamic tree options: `options_tree_path`
- conditional input visibility with `visible_if`
- action-to-input wiring via `actions[].inputs`
- collapsible group containers with `collapsed: true`
- namelist editor widget with `tree_path` binding

## Duplicate install/update semantics

Installing a module that already exists does not overwrite files silently. PDV reports:

- `up_to_date`
- `update_available`
- `incompatible_update`

Current vs candidate version/revision metadata is surfaced so the UI can show explicit update status. Remote update checks are currently scaffolded (`checkUpdates` returns `not_implemented`).

## Import behavior and aliasing

When importing to a project:

- each imported module gets a project-local alias
- alias conflicts return `conflict` plus a suggested alias (`name_1`)
- imported module metadata is persisted in project data
- imports can be staged before first save, then written on save

Imported modules are listed with:

- module identity/version
- declarative inputs/actions
- persisted settings
- evaluated health warnings

## Tree binding on import

When a module is imported into a project with an active kernel, the main process binds a tree structure under `<alias>`:

```
<alias>/                  ← PDVModule node (module metadata)
  gui                     ← PDVGui node (if gui.json exists)
  <namelist_name>         ← PDVNamelist node (for each file with type "namelist")
  lib/                    ← folder
    <stem>                ← PDVLib node (for each .py file in lib/)
  scripts/                ← folder
    <script_name>         ← PDVScript node (for each action script)
```

Each node type is a first-class tree citizen:

| Node | Class | Purpose |
|---|---|---|
| `PDVModule` | dict subclass of `PDVTree` | Module metadata (id, name, version) |
| `PDVGui` | subclass of `PDVFile` | GUI layout definition (`.gui.json`) |
| `PDVNamelist` | subclass of `PDVFile` | Editable simulation namelist |
| `PDVLib` | subclass of `PDVFile` | Importable Python library |
| `PDVScript` | `PDVScript` | Executable action script |

The bind sequence (`bindImportedModule` in `module-runtime.ts`) runs in order:

1. Register `PDVModule` node at `<alias>`
2. Copy `gui.json` → register `PDVGui` at `<alias>.gui`
3. Copy manifest `files[]` → register `PDVNamelist`/`PDVFile` nodes
4. Copy `lib/*.py` files → register `PDVLib` nodes under `<alias>.lib`
5. Copy action scripts → register `PDVScript` nodes under `<alias>.scripts`
6. Send `pdv.modules.setup` to kernel with `lib_paths` and `entry_point`

## The `lib/` directory and Python namespace setup

Module developers place importable `.py` files in `<module-root>/lib/`. These files are the mechanism for sharing code between scripts and for defining custom data types with double-click handlers.

On import, the main process:

1. Copies each `.py` file from the installed module's `lib/` directory to the working directory under `<alias>/lib/`.
2. Registers each as a `PDVLib` tree node (visible and editable in the tree).
3. Sends `pdv.modules.setup` with `lib_paths` — the on-disk paths of the copied files. The kernel adds the parent directory of each path to `sys.path`.
4. If the manifest specifies an `entry_point`, the kernel imports that module (which can register custom type handlers via `@handle`).

This design:
- Makes lib files visible and editable in the tree — users can modify libraries while working.
- Is forward-compatible with planned UUID-based file storage where each file gets its own directory.
- Keeps `sys.path` entries per-file rather than per-module, so each lib file works independently.

On project load (deserialization), `PDVLib` nodes are restored and their parent directories are re-added to `sys.path`.

## Custom type handlers

Module `lib/` files can define custom Python classes and register double-click handlers using the `@handle` decorator:

```python
from pdv_kernel import handle

class PendulumSolution:
    def __init__(self, t, thetas, omegas, xs, ys, params):
        self.t = t
        # ...

@handle(PendulumSolution)
def plot_pendulum(sol, path, pdv_tree):
    import matplotlib.pyplot as plt
    # ... create plot ...
    plt.show()
```

When the user double-clicks a tree node containing a `PendulumSolution`, the registered handler is dispatched via `pdv.handler.invoke`. The handler walks the MRO of the stored object to find the best match.

The `entry_point` in the manifest triggers the import that registers these handlers at kernel startup.

## Script binding into `pdv_tree`

Each imported module action is bound to canonical script nodes:

- `<alias>.scripts.<scriptName>`

These nodes are registered as PDV scripts and can be executed directly, e.g.:

```python
pdv_tree["n_pendulum.scripts.solve"].run(n_links=3, n_steps=5000)
```

Binding is idempotent across reload/restart. Script files are copied into the kernel working directory for editable working copies, while module store sources remain unchanged.

## Module GUI windows

Modules with a `gui.json` get a dedicated GUI button in the activity bar (showing the first letter of the module name). Clicking it opens a separate Electron `BrowserWindow` rendering the declarative GUI layout.

### Layout container types

The `gui.layout` object is a recursive tree of container and leaf nodes. Container types:

| Type | Description |
|---|---|
| `row` | Horizontal flexbox — children side by side |
| `column` | Vertical flexbox — children stacked. When used as a direct child of `tabs`, the `label` property becomes the tab title. |
| `group` | Collapsible section with a `label` header. `collapsed: true` starts it folded. |
| `tabs` | Tabbed container — each direct child (typically `column`) becomes a tab. |

### Leaf node types

| Type | Description |
|---|---|
| `input` | Renders the input control matching `id` from `inputs[]`. |
| `action` | Renders the action button matching `id` from `actions[]`. |
| `namelist` | Inline namelist editor bound to a `PDVNamelist` tree node via `tree_path`. Optionally uses `tree_path_input` to dynamically override the path from a dropdown input. |

### Communication

GUI windows communicate with the main window kernel through `window.pdv.moduleWindows.*`. Each module window calls `context()` on mount to learn its alias and kernel ID, and uses `executeInMain(code)` to run code in the main window's kernel.

## Modules UI functionality

The renderer provides two module views:

1. **Module Library**
   - list installed modules
   - install from local folder (GitHub URL scaffolded but not yet functional)
   - import installed module into project
   - show status badges (imported, warning count)
   - show duplicate/update prompts
2. **Imported Modules**
   - one tab per imported module alias
   - render declarative inputs/actions from manifest
   - run actions against the active kernel
   - show non-blocking module health warnings
   - persist per-module settings (including UI state)

## Action execution path

Running a module action:

1. resolves action ID to a bound script node
2. generates execution code for that script run call
3. executes through normal kernel execution path
4. displays output/errors in the existing console flow

This keeps module actions transparent and consistent with normal script execution behavior.

## Health checks and warnings

PDV evaluates non-blocking module health warnings at import/load time. Warning codes:

| Code | Trigger |
|---|---|
| `module_source_missing` | Installed module directory no longer exists on disk |
| `pdv_version_incompatible` | Current PDV version is below `pdv_min` or above `pdv_max` |
| `python_version_unknown` | Could not detect the active Python version |
| `python_version_incompatible` | Active Python version is outside `python_min`–`python_max` |
| `dependency_unverified` | A declared dependency could not be verified (warn-only) |
| `missing_action_script` | A script file referenced by an action does not exist |

Warnings are surfaced in module UI tabs and import results.
