"""
PDVKernel — Physics Data Viewer kernel support package for Julia.

The Julia counterpart of `pdv-python`: implements the kernel side of the PDV
comm protocol (ARCHITECTURE.md §3) on top of IJulia. It is installed into the
user's Julia environment and loaded by the bootstrap snippet the PDV app
executes when a Julia kernel starts (see `electron/main/kernel-session.ts`).

Public API
----------
- `pdv_tree` (injected into `Main` as a `const` at bootstrap) — the live
  project data tree, sole authority on all project data.
- `PDVTree`, `PDVScript`, `PDVFile`, `PDVNote`, `PDVGui`, `PDVNamelist`,
  `PDVModule`, `PDVLib` — tree node types.
- `bootstrap()` — idempotent kernel-side initialization.
- `save()`, `save_project(path)`, `save_project_as(path)`, `open_project(path)`,
  `install(pkgs...)`, `remove(pkgs...)`, `update(pkgs...)`, `add_file(path)`,
  `add_hdf5(path)`, `new_note(path; title)`, `help()`, `working_dir()`,
  `log(args...)` — app-level operations.
- `pdv_handle` / `pdv_preview` / `pdv_format` / `pdv_serialize` /
  `pdv_deserialize` / `pdv_digest` — protocol generic functions that modules
  extend with methods (the Julia analog of Python's `@pdv.handle` decorator
  and dunder protocol).
- `register_serializer`, `register_handler` — explicit registration for
  types the caller does not own.
"""
module PDVKernel

using UUIDs
using Dates
import JSON
import NPZ
import SHA
import TOML
import ZMQ
import Serialization
import IJulia
import Pkg

# Unified PDV version (must match electron/package.json and
# pdv-python/pyproject.toml — ARCHITECTURE.md key design rule 10). Probed by
# the app's environment detector via `println(PDVKernel.VERSION)`.
const VERSION = "0.2.0"
const __pdv_protocol_version__ = VERSION

export PDVTree, PDVModule, PDVFile, PDVScript, PDVNote, PDVGui, PDVNamelist,
       PDVLib, PDVHdf5, PDVException, PDVPathError, PDVKeyError, PDVProtectedNameError,
       PDVSerializationError, PDVScriptError, PDVVersionError,
       bootstrap, register_serializer, register_handler,
       pdv_handle, pdv_preview, pdv_format, pdv_serialize, pdv_deserialize,
       pdv_digest, run_tree_script

include("errors.jl")
include("environment.jl")
include("serializers.jl")
include("virtual.jl")
include("tree.jl")
include("serialization.jl")
include("checksum.jl")
include("namespace.jl")
include("modules.jl")
include("default_handlers.jl")
include("script_exec.jl")
include("namelist_utils.jl")
include("tree_loader.jl")
include("comms.jl")
include("query_cache.jl")
include("query_server.jl")
include("handlers/registry.jl")
include("handlers/lifecycle.jl")
include("handlers/project.jl")
include("handlers/tree.jl")
include("handlers/namespace.jl")
include("handlers/introspection.jl")
include("handlers/script.jl")
include("handlers/note.jl")
include("handlers/gui.jl")
include("handlers/namelist.jl")
include("handlers/modules.jl")

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

"""
    bootstrap()

Bootstrap the PDV kernel package inside a running IJulia kernel. Idempotent —
calling it twice produces no side effects beyond the first call.

Creates the live `PDVTree`, injects it into `Main` as `const pdv_tree`
(Julia's `const` rejection of rebinding replaces Python's protected
namespace), and attaches the comm send function for push notifications. The
comm itself is opened — and `pdv.ready` sent — by the bootstrap snippet the
app executes (see JULIA_BOOTSTRAP in `electron/main/kernel-session.ts`),
which assigns `PDVKernel._comm[]`.
"""
function bootstrap()
    _bootstrapped[] && return nothing

    tree = PDVTree()
    _pdv_tree[] = tree

    # Inject as a const in Main. `const` makes user reassignment of
    # `pdv_tree` an error, mirroring PDVProtectedNameError semantics.
    if !isdefined(Main, :pdv_tree)
        Core.eval(Main, :(const pdv_tree = $tree))
    end

    attach_comm!(tree, (msg_type, payload) -> send_message(msg_type, payload))

    _bootstrapped[] = true
    nothing
end

# ---------------------------------------------------------------------------
# Public app-level API (port of pdv/__init__.py functions)
# ---------------------------------------------------------------------------

"""
    working_dir() -> String

The session working directory (available after `pdv.init`).
"""
function working_dir()::String
    tree = get_pdv_tree()
    tree === nothing && error("PDV kernel has not been bootstrapped")
    tree.working_dir === nothing &&
        throw(PDVException_working_dir_unavailable())
    return tree.working_dir
end

# Small helper so the error carries the same message as Python's.
PDVException_working_dir_unavailable() =
    PDVPathError("PDVKernel.working_dir is not available: kernel has not received pdv.init")

"""
    save()

Trigger a project save. Equivalent to File → Save in the UI.
"""
save() = save_project()

"""
    save_project(path=nothing)

Save the current project. With no `path`, saves to the current project
location (or asks the app to run its save flow when no project is open).
"""
function save_project(path::Union{Nothing,AbstractString}=nothing)
    try
        tree = get_pdv_tree()
        if tree === nothing
            println("PDV: Tree is not initialized. Cannot save.")
            return nothing
        end
        save_dir = path !== nothing ? abspath(expanduser(String(path))) : tree.save_dir
        if save_dir === nothing || isempty(save_dir)
            send_message("pdv.project.save_request", Dict{String,Any}())
            return nothing
        end
        results = serialize_tree_to_dir(tree, save_dir)
        if !isempty(get(results, "missing_files", String[]))
            missing_files = results["missing_files"]
            println("PDV: save aborted — $(length(missing_files)) node(s) have " *
                    "missing backing files; nothing was persisted:\n  " *
                    join(missing_files, "\n  "))
        end
        send_message("pdv.project.save_completed",
                     merge(Dict{String,Any}("save_dir" => save_dir), results))
    catch err
        println("PDV: save_project failed: $(sprint(showerror, err))")
    end
    nothing
end

"""
    save_project_as(path)

Save the project to a new directory (Save As).
"""
function save_project_as(path::AbstractString)
    try
        tree = get_pdv_tree()
        if tree === nothing
            println("PDV: Tree is not initialized. Cannot save.")
            return nothing
        end
        resolved = abspath(expanduser(String(path)))
        results = serialize_tree_to_dir(tree, resolved)
        send_message("pdv.project.save_completed",
                     merge(Dict{String,Any}("save_dir" => resolved), results))
    catch err
        println("PDV: save_project_as failed: $(sprint(showerror, err))")
    end
    nothing
end

"""
    open_project(path)

Ask the app to open a project from a directory.
"""
function open_project(path::AbstractString)
    try
        resolved = abspath(expanduser(String(path)))
        send_message("pdv.project.open_request", Dict{String,Any}("save_dir" => resolved))
    catch
        println("PDV: No comm channel open. Cannot open project.")
    end
    nothing
end

"""
    install(packages...)

Install Julia packages into the active environment via `Pkg.add`, blocking
the cell until the install finishes. The packages become loadable without a
kernel restart. (The Julia analog of `pdv.install()`, delegating to Pkg
rather than uv.) Each package is a name, optionally with a REPL-style
version pin — `install("DataFrames")` or `install("DataFrames@1.6")` —
which `Pkg.add`'s string form does not accept but this function translates
to a `PackageSpec` for you.

In a pkg-mode session (ARCHITECTURE.md §10.6) the active environment is the
project's own — the app launches the kernel with `JULIA_PROJECT` pointing at
the session working directory — so the install is recorded in the project's
`Project.toml`/`Manifest.toml` and travels with the save. In a legacy
shared-mode session it lands in the user's default environment.
"""
function install(packages::AbstractString...)
    if isempty(packages)
        println("PDVKernel.install: no packages specified.")
        return nothing
    end
    println("PDVKernel.install: Pkg.add($(join(packages, ", ")))")
    Pkg.add([_package_spec(String(p)) for p in packages])
    nothing
end

"""
    _package_spec(package) -> Pkg.PackageSpec

Translate a package string into a `Pkg.PackageSpec`, accepting the REPL-style
`"Name@version"` pin form that `Pkg.add(::String)` rejects.
"""
function _package_spec(package::String)
    if occursin('@', package)
        name, version = split(package, '@'; limit=2)
        return Pkg.PackageSpec(name=String(name), version=String(version))
    end
    return Pkg.PackageSpec(name=package)
end

"""
    remove(packages...)

Remove Julia packages from the active environment via `Pkg.rm`, blocking the
cell until the operation finishes. In a pkg-mode session (ARCHITECTURE.md
§10.6) this edits the project's `Project.toml`/`Manifest.toml`. An already-
loaded module stays loaded until the kernel restarts — removal only affects
what future `using`/`import` can resolve.
"""
function remove(packages::AbstractString...)
    if isempty(packages)
        println("PDVKernel.remove: no packages specified.")
        return nothing
    end
    println("PDVKernel.remove: Pkg.rm($(join(packages, ", ")))")
    Pkg.rm(collect(String.(packages)))
    nothing
end

"""
    update(packages...)

Upgrade Julia packages in the active environment via `Pkg.update`, blocking
the cell until the operation finishes. With no arguments, upgrades every
package the environment allows. In a pkg-mode session (ARCHITECTURE.md §10.6)
the new versions are recorded in the project's `Manifest.toml`. A package
already loaded in this session keeps its old version until the kernel
restarts — `Pkg` prints a note when that applies.
"""
function update(packages::AbstractString...)
    if isempty(packages)
        println("PDVKernel.update: Pkg.update()")
        Pkg.update()
    else
        println("PDVKernel.update: Pkg.update($(join(packages, ", ")))")
        Pkg.update(collect(String.(packages)))
    end
    nothing
end

# Shared import-file plumbing: validate the source, copy it into UUID
# storage under the session working directory, and return (uuid, filename).
function _import_file_common(source_path::AbstractString,
                             api_name::String)::Tuple{String,String}
    resolved = abspath(expanduser(String(source_path)))
    isfile(resolved) || (ispath(resolved) ?
        throw(ArgumentError("Source path is not a file: $source_path")) :
        throw(ArgumentError("Source file not found: $source_path")))

    tree = get_pdv_tree()
    wd = tree === nothing ? nothing : tree.working_dir
    wd === nothing && throw(PDVPathError(
        "PDVKernel.$api_name is not available: kernel has not received pdv.init"))

    filename = basename(resolved)
    node_uuid = generate_node_uuid()
    dest = uuid_tree_path(wd, node_uuid, filename)
    smart_copy(resolved, dest)
    return (node_uuid, filename)
end

"""
    add_file(source_path) -> AbstractPDVFile

Import an arbitrary file into the tree. Eagerly copies the source into the
session working directory under a fresh UUID storage path; assign the
returned node at the desired tree path:

    mesh = PDVKernel.add_file("~/Downloads/mesh.h5")
    pdv_tree["simulation.mesh"] = mesh

Files with an HDF5 extension (`.h5`/`.hdf5`) come back as a lazily-read
[`PDVHdf5`](@ref) node; everything else as a generic `PDVFile`. Use
[`add_hdf5`](@ref) to force the HDF5 node type for other extensions.
"""
function add_file(source_path::AbstractString)::AbstractPDVFile
    node_uuid, filename = _import_file_common(source_path, "add_file")
    ext = lowercase(last(splitext(filename)))
    if ext in HDF5_EXTENSIONS
        preload_hdf5!()
        return PDVHdf5(uuid=node_uuid, filename=filename)
    end
    return PDVFile(uuid=node_uuid, filename=filename)
end

"""
    add_hdf5(source_path) -> PDVHdf5

Import an HDF5 file into the tree as a lazily-read [`PDVHdf5`](@ref) node.

Like [`add_file`](@ref) but always constructs an HDF5 node regardless of
extension, and checks that HDF5.jl is installed *before* copying the file —
so a missing dependency fails fast with an actionable message instead of
after a multi-GB copy.
"""
function add_hdf5(source_path::AbstractString)::PDVHdf5
    (loaded_module(:HDF5) !== nothing || hdf5_installed()) ||
        error(_hdf5_dep_error_message())
    preload_hdf5!()
    node_uuid, filename = _import_file_common(source_path, "add_hdf5")
    return PDVHdf5(uuid=node_uuid, filename=filename)
end

"""
    new_note(path; title=nothing)

Create a markdown note in the tree at a dot-separated path.
"""
function new_note(path::AbstractString; title::Union{Nothing,AbstractString}=nothing)
    tree = get_pdv_tree()
    if tree === nothing
        println("PDV: Tree is not initialized. Cannot create note.")
        return nothing
    end
    wd = tree.working_dir === nothing ? "." : tree.working_dir
    segments = split(path, ".")
    filename = String(segments[end]) * ".md"
    node_uuid = generate_node_uuid()
    file_path = uuid_tree_path(wd, node_uuid, filename)
    ensure_parent(file_path)
    if !isfile(file_path)
        open(file_path, "w") do io
            title !== nothing && println(io, "# ", title)
        end
    end
    note = PDVNote(uuid=node_uuid, filename=filename,
                   title=title === nothing ? nothing : String(title))
    tree[path] = note
    println("Created note at '$path'")
    nothing
end

"""
    help(topic=nothing)

Print PDV help.
"""
function help(topic::Union{Nothing,AbstractString}=nothing)
    if topic === nothing
        println(
            "PDV Help\n" *
            "--------\n" *
            "  pdv_tree            — the project data tree (dict-like)\n" *
            "  pdv_tree[\"path\"]    — access or set a node by dot-path\n" *
            "  PDVKernel.run_script(pdv_tree, \"path\") — run a script node\n" *
            "  PDVKernel.working_dir() — session working dir (for data files)\n" *
            "  PDVKernel.save()    — save the project\n" *
            "  PDVKernel.save_project(\"path\")    — save project to a directory\n" *
            "  PDVKernel.save_project_as(\"path\") — save project to a new directory\n" *
            "  PDVKernel.open_project(\"path\")    — open a project from a directory\n" *
            "  PDVKernel.install(\"Pkg1\", \"Pkg2\") — install Julia packages\n" *
            "  PDVKernel.remove(\"Pkg1\")  — remove packages from the environment\n" *
            "  PDVKernel.update()         — upgrade packages (or update(\"Pkg1\"))\n" *
            "  PDVKernel.add_file(\"path/to/file\") — import a file into the tree\n" *
            "  PDVKernel.add_hdf5(\"path/to/file.h5\") — import an HDF5 file (lazy)\n" *
            "  PDVKernel.new_note(\"path\"; title=\"My Note\") — create a markdown note\n" *
            "  PDVKernel.help(\"pdv_tree\") — help on a specific topic\n")
    else
        println("PDV help for topic '$topic' is not yet implemented.")
    end
    nothing
end

"""
    log(args...)

Print a debug message directly to the real stderr (fd 2), bypassing IJulia's
stream capture, so it appears in the Electron terminal prefixed with
`[kernel:<id>]`.
"""
function log(args...)
    msg = join(string.(args), " ") * "\n"
    bytes = Vector{UInt8}(codeunits(msg))
    ccall(:write, Cssize_t, (Cint, Ptr{UInt8}, Csize_t), 2, bytes, length(bytes))
    nothing
end

end # module PDVKernel
