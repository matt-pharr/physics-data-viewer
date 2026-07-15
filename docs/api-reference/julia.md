<!-- GENERATED FILE — do not edit by hand.
     Regenerate with:
       julia --project=pdv-julia pdv-julia/scripts/generate-api-docs.jl
     and commit the result. -->

# Julia API (`PDVKernel`)

This reference documents the Julia surface exposed by the `PDVKernel`
package — the [Julia counterpart](../developer/architecture.md) of
`pdv-python`, with full protocol parity. Everything here is extracted from
the package's docstrings.

Two primary names, as in Python:

| Name        | What it is                                                                                     | Reference |
|-------------|------------------------------------------------------------------------------------------------|-----------|
| `pdv_tree`  | The live project data tree (dict-like). **Injected** into `Main` as a `const` at kernel startup. | [The Tree](#the-tree-pdv_tree) |
| `PDVKernel` | The package itself, exposing session-level functions.                                            | [App-Level Operations](#app-level-operations) |

The deliberate Julia translations from the Python API: multiple-dispatch
generic functions replace decorators and dunder protocols, `.jls`
`Serialization` replaces pickle, sequence dot-paths are 1-based, and
per-project environments are Pkg-managed (`Project.toml`/`Manifest.toml`)
rather than uv-managed.

## The Tree (`pdv_tree`)

`pdv_tree` is the live project data tree, injected into `Main` as a
`const` at kernel startup (Julia's `const` rejection of rebinding
replaces Python's protected namespace). It behaves like a `Dict`
with dot-path access — `pdv_tree["results.run_01.temperature"]`
resolves through intermediate dicts, creating them on write.
Sequence indices in dot-paths are **1-based** (`pdv_tree["xs.1"]`),
matching Julia convention; negative indices count from the end.

### `PDVKernel.PDVTree`

```
PDVTree()
```

The live project data tree — the sole authority on all project data (ARCHITECTURE.md §5.6, §7.1). Supports dot-path access (`tree["data.waveforms.ch1"]`) and emits `pdv.tree.changed` push notifications on mutation when a comm is attached via `attach_comm!`.

## Tree Node Types

Values assigned into the tree are either plain data (numbers,
strings, arrays, `Dict`s, arbitrary serializable structs) or
instances of the node types below, which carry file-backed or
app-visible behavior.

### `PDVKernel.PDVScript`

```
PDVScript(; uuid, filename, language="julia", doc=nothing, module_id="",
          source_rel_path=nothing)
```

Script node. `script.run` is exposed via `script_run` / `run_tree_script`; every run loads the file fresh into an anonymous module so in-place edits always take effect. See ARCHITECTURE.md §5.7.

### `PDVKernel.PDVFile`

```
PDVFile(; uuid, filename, source_rel_path=nothing)
```

Generic file-backed tree node (fallback kind `"file"`). See ARCHITECTURE.md §5.8.

### `PDVKernel.PDVNote`

```
PDVNote(; uuid, filename, title=nothing)
```

Markdown note node backed by a `.md` file.

### `PDVKernel.PDVGui`

```
PDVGui(; uuid, filename, module_id=nothing, source_rel_path=nothing)
```

GUI definition node backed by a `.gui.json` file.

### `PDVKernel.PDVNamelist`

```
PDVNamelist(; uuid, filename, format="auto", module_id=nothing,
            source_rel_path=nothing)
```

Namelist node (`"fortran"`, `"toml"`, or `"auto"`) backed by a namelist file.

### `PDVKernel.PDVModule`

```
PDVModule(; module_id, name, version, gui=nothing, dependencies=[],
          description="", language="julia")
```

Module metadata node. A `PDVTree`-like container so it holds children naturally (ARCHITECTURE.md §5.9).

### `PDVKernel.PDVLib`

```
PDVLib(; uuid, filename, module_id=nothing, source_rel_path=nothing)
```

Julia library file provided by a module's `lib/` branch. Lib files are `include`d into `Main` by `pdv.modules.setup` so their exports are available to scripts and handlers (the Julia analog of Python's `sys.path` wiring).

## App-Level Operations

The Julia analog of the `pdv` package's module-level functions:
session-level operations that act on the running PDV application,
called as `PDVKernel.<name>(...)` from any code cell.

### `PDVKernel.working_dir`

```
working_dir() -> String
```

The session working directory (available after `pdv.init`).

### `PDVKernel.save`

```
save()
```

Trigger a project save. Equivalent to File → Save in the UI.

### `PDVKernel.save_project`

```
save_project(path=nothing)
```

Save the current project. With no `path`, saves to the current project location (or asks the app to run its save flow when no project is open).

### `PDVKernel.save_project_as`

```
save_project_as(path)
```

Save the project to a new directory (Save As).

### `PDVKernel.open_project`

```
open_project(path)
```

Ask the app to open a project from a directory.

### `PDVKernel.install`

```
install(packages...)
```

Install Julia packages into the active environment via `Pkg.add`, blocking the cell until the install finishes. The packages become loadable without a kernel restart. (The Julia analog of `pdv.install()`, delegating to Pkg rather than uv.) Each package is a name, optionally with a REPL-style version pin — `install("DataFrames")` or `install("DataFrames@1.6")` — which `Pkg.add`'s string form does not accept but this function translates to a `PackageSpec` for you.

In a pkg-mode session (ARCHITECTURE.md §10.6) the active environment is the project's own — the app launches the kernel with `JULIA_PROJECT` pointing at the session working directory — so the install is recorded in the project's `Project.toml`/`Manifest.toml` and travels with the save. In a legacy shared-mode session it lands in the user's default environment.

### `PDVKernel.remove`

```
remove(packages...)
```

Remove Julia packages from the active environment via `Pkg.rm`, blocking the cell until the operation finishes. In a pkg-mode session (ARCHITECTURE.md §10.6) this edits the project's `Project.toml`/`Manifest.toml`. An already- loaded module stays loaded until the kernel restarts — removal only affects what future `using`/`import` can resolve.

### `PDVKernel.update`

```
update(packages...)
```

Upgrade Julia packages in the active environment via `Pkg.update`, blocking the cell until the operation finishes. With no arguments, upgrades every package the environment allows. In a pkg-mode session (ARCHITECTURE.md §10.6) the new versions are recorded in the project's `Manifest.toml`. A package already loaded in this session keeps its old version until the kernel restarts — `Pkg` prints a note when that applies.

### `PDVKernel.add_file`

```
add_file(source_path) -> PDVFile
```

Import an arbitrary file into the tree as a `PDVFile`. Eagerly copies the source into the session working directory under a fresh UUID storage path; assign the returned node at the desired tree path:

```
mesh = PDVKernel.add_file("~/Downloads/mesh.h5")
pdv_tree["simulation.mesh"] = mesh
```

### `PDVKernel.new_note`

```
new_note(path; title=nothing)
```

Create a markdown note in the tree at a dot-separated path.

### `PDVKernel.help`

```
help(topic=nothing)
```

Print PDV help.

### `PDVKernel.log`

```
log(args...)
```

Print a debug message directly to the real stderr (fd 2), bypassing IJulia's stream capture, so it appears in the Electron terminal prefixed with `[kernel:<id>]`.

## Protocol Generic Functions (Module API)

Where Python modules use decorators (`@pdv.handle`) and dunder
methods (`__pdv_format__`, …), Julia modules extend **generic
functions** with methods for their own types — multiple dispatch is
the extension mechanism. Define a method and PDV picks it up; user
methods always win over the built-in defaults by dispatch
specificity.

### `PDVKernel.pdv_handle`

```
pdv_handle(obj, path::AbstractString, tree)
```

Protocol hook: double-click handler for tree nodes holding values of the method's type. The Julia analog of Python's `@pdv.handle` decorator — modules register handlers by adding methods (see the bundled N-pendulum-julia module).

### `PDVKernel.pdv_preview`

```
pdv_preview(obj) -> String
```

Protocol hook: short human-readable preview shown in the tree panel.

### `PDVKernel.pdv_format`

```
pdv_format(::Type{T}) -> (format_name::String, extension::String)
```

Protocol hook: declare the on-disk format for values of type `T`. Required (together with `pdv_serialize` and `pdv_deserialize`) to opt a type into PDV persistence.

### `PDVKernel.pdv_serialize`

```
pdv_serialize(obj, abs_path::AbstractString)
```

Protocol hook: write `obj`'s state to `abs_path`. PDV chooses the path.

### `PDVKernel.pdv_deserialize`

```
pdv_deserialize(::Type{T}, abs_path::AbstractString) -> T
```

Protocol hook: read the file written by `pdv_serialize` and return a reconstructed instance.

### `PDVKernel.pdv_digest`

```
pdv_digest(obj) -> Vector{UInt8} | String
```

Protocol hook: stable byte payload used for change-detection checksums.

### `PDVKernel.register_handler`

```
register_handler(func, T::Type)
```

Register `func(obj, path, tree)` as the double-click handler for values of type `T` (and subtypes, via supertype walk). The explicit-registration analog of adding a `pdv_handle` method; registered handlers take precedence.

### `PDVKernel.register_serializer`

```
register_serializer(T::Type; format, extension=".bin", save, load, preview=nothing)
```

Register a custom serializer for instances of `T`. PDV chooses the on-disk filename and passes an absolute path to `save(obj, abs_path)`; `load(abs_path)` must return a reconstructed instance at project-load time. Lookup walks the type hierarchy, so a serializer registered on an abstract type also covers subtypes.

Throws `PDVSerializationError` when `format` is empty or collides with a builtin format name.

## Script Execution

PDV scripts define `run(pdv_tree; kwargs...)`; the app invokes them
through `run_tree_script`, which is also callable directly from a
cell.

### `PDVKernel.run_tree_script`

```
run_tree_script(tree, script_path; kwargs...) -> Any
```

Entry point used by the app's `script:run` IPC handler (see `ipc-register-tree-namespace-script.ts`). Identical to `run_script`.

## Exceptions

PDV error types, mirroring `pdv-python`'s exception hierarchy.

### `PDVKernel.PDVException`

```
PDVException
```

Abstract supertype for all PDVKernel errors (mirror of Python's `PDVError`).

### `PDVKernel.PDVPathError`

Raised when a path is invalid, escapes the project root, or is otherwise unsafe.

### `PDVKernel.PDVKeyError`

Raised when a tree path does not exist.

### `PDVKernel.PDVProtectedNameError`

Raised when user code attempts to reassign a protected kernel namespace name.

### `PDVKernel.PDVSerializationError`

Raised when a value cannot be serialized to or deserialized from disk.

### `PDVKernel.PDVScriptError`

Raised when a script fails to load or its `run()` function throws.

### `PDVKernel.PDVVersionError`

Raised when the app's expected protocol version is incompatible with this package.
