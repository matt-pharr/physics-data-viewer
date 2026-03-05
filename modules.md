# PDV Modules Feature

This document describes the currently implemented **Modules** feature in PDV: how modules are installed, imported into projects, rendered in the UI, and executed through `pdv_tree`.

## What a module is

A module is a package with:

- a manifest file: `pdv-module.json`
- one or more Python action scripts referenced by the manifest
- optional declarative UI input definitions for those actions

See the example module:

- Manifest: [`examples/modules/N-pendulum/pdv-module.json`](examples/modules/N-pendulum/pdv-module.json)
- Action scripts:
  - [`examples/modules/N-pendulum/scripts/solve.py`](examples/modules/N-pendulum/scripts/solve.py)
  - [`examples/modules/N-pendulum/scripts/animate.py`](examples/modules/N-pendulum/scripts/animate.py)

## Install model (global) vs import model (project-scoped)

PDV separates module lifecycle into two steps:

1. **Install** into a global module store (`~/.PDV/modules/...`), from:
   - a local folder path, or
   - a GitHub repository URL.
2. **Import** an installed module into the current project with a project-local alias.

Installed modules are globally available; imported modules are project-specific.

## Global module store and metadata

The Electron main process manages module storage and metadata:

- Packages root: `<pdvDir>/modules/packages`
- Metadata index: `<pdvDir>/modules/index.json`

Installation validates `pdv-module.json` and stores normalized metadata (`id`, `name`, `version`, source, revision when available).

## Supported manifest functionality (`pdv-module.json`)

PDV currently supports the following manifest capabilities:

- Required module identity fields (`schema_version`, `id`, `name`, `version`)
- `description`
- `actions[]` with:
  - `id`
  - `label`
  - `script_path`
  - optional `inputs` (input IDs consumed by the action)
  - optional `tab` (module-internal UI tab grouping)
- `inputs[]` with declarative controls:
  - `control`: `text`, `dropdown`, `slider`, `checkbox`, `file`
  - `default`, `type`, `label`, `tooltip`
  - grouping: `tab`, `section`, `section_collapsed`
  - conditional visibility: `visible_if`
  - slider metadata: `min`, `max`, `step`
  - file picker mode: `file_mode` (`file`/`directory`)
  - dropdown options:
    - static `options`
    - dynamic `options_tree_path` (populate from tree children)
- optional `compatibility` metadata:
  - `pdv_min`, `pdv_max`
  - `python`, `python_min`, `python_max`
- optional `dependencies[]` (warn-only in v1)

For concrete syntax examples, use the N-pendulum manifest:

- dropdown with dynamic tree options: `options_tree_path`
- conditional input visibility with `visible_if`
- action-to-input wiring via `actions[].inputs`

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

## Script binding into `pdv_tree`

Each imported module action is bound to canonical script nodes:

- `<alias>.scripts.<scriptName>`

These nodes are registered as PDV scripts and can be executed directly, e.g.:

```python
pdv_tree["n_pendulum.scripts.solve"].run(n_links=3, n_steps=5000)
```

Binding is idempotent across reload/restart. Script files are copied into the kernel working directory for editable working copies, while module store sources remain unchanged.

## Modules UI functionality

The renderer provides two module views:

1. **Module Library**
   - list installed modules
   - install from local folder or GitHub URL
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

PDV evaluates non-blocking module health warnings at import/load time, including:

- PDV version compatibility
- Python version compatibility
- dependency requirement awareness (warn-only)
- missing action scripts
- missing module source

Warnings are surfaced in module UI tabs and import results.
