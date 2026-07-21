# tree.jl — PDVTree, PDVModule, and the file-backed node structs.
#
# Port of pdv/tree.py. Implements:
#   - `PDVTree`: an AbstractDict{String,Any} that is the live project data
#     tree, with dot-path access and debounced `pdv.tree.changed` push
#     notifications on mutation (when a comm is attached).
#   - `PDVModule`: a PDVTree-like container carrying module metadata.
#   - `PDVFile` and subkinds (`PDVScript`, `PDVNote`, `PDVGui`, `PDVNamelist`,
#     `PDVLib`): file-backed tree nodes with UUID storage (§6.3).
#
# This file has NO dependency on IJulia or comms — the send function is
# injected via `attach_comm!`.

# ---------------------------------------------------------------------------
# File-backed nodes
# ---------------------------------------------------------------------------

"""
    AbstractPDVFile

Supertype of every file-backed PDV tree node. All concrete subtypes carry
`uuid` (12-hex storage directory id), `filename`, and `source_rel_path`
(module-root-relative path for module-owned files, or `nothing`).
"""
abstract type AbstractPDVFile end

"""
    PDVFile(; uuid, filename, source_rel_path=nothing)

Generic file-backed tree node (fallback kind `"file"`). See ARCHITECTURE.md §5.8.
"""
mutable struct PDVFile <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
end
PDVFile(; uuid::AbstractString, filename::AbstractString,
        source_rel_path::Union{Nothing,AbstractString}=nothing) =
    PDVFile(String(uuid), String(filename),
            source_rel_path === nothing ? nothing : String(source_rel_path))

"""
    PDVScript(; uuid, filename, language="julia", doc=nothing, module_id="",
              source_rel_path=nothing)

Script node. `script.run` is exposed via [`script_run`](@ref) /
[`run_tree_script`](@ref); every run loads the file fresh into an anonymous
module so in-place edits always take effect. See ARCHITECTURE.md §5.7.
"""
mutable struct PDVScript <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
    language::String
    doc::Union{Nothing,String}
    module_id::String
end
PDVScript(; uuid::AbstractString, filename::AbstractString,
          language::AbstractString="julia",
          doc::Union{Nothing,AbstractString}=nothing,
          module_id::AbstractString="",
          source_rel_path::Union{Nothing,AbstractString}=nothing) =
    PDVScript(String(uuid), String(filename),
              source_rel_path === nothing ? nothing : String(source_rel_path),
              String(language), doc === nothing ? nothing : String(doc),
              String(module_id))

"""
    PDVNote(; uuid, filename, title=nothing)

Markdown note node backed by a `.md` file.
"""
mutable struct PDVNote <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
    title::Union{Nothing,String}
end
PDVNote(; uuid::AbstractString, filename::AbstractString,
        title::Union{Nothing,AbstractString}=nothing) =
    PDVNote(String(uuid), String(filename), nothing,
            title === nothing ? nothing : String(title))

"""
    PDVGui(; uuid, filename, module_id=nothing, source_rel_path=nothing)

GUI definition node backed by a `.gui.json` file.
"""
mutable struct PDVGui <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
    module_id::Union{Nothing,String}
end
PDVGui(; uuid::AbstractString, filename::AbstractString,
       module_id::Union{Nothing,AbstractString}=nothing,
       source_rel_path::Union{Nothing,AbstractString}=nothing) =
    PDVGui(String(uuid), String(filename),
           source_rel_path === nothing ? nothing : String(source_rel_path),
           module_id === nothing ? nothing : String(module_id))

"""
    PDVNamelist(; uuid, filename, format="auto", module_id=nothing,
                source_rel_path=nothing)

Namelist node (`"fortran"`, `"toml"`, or `"auto"`) backed by a namelist file.
"""
mutable struct PDVNamelist <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
    format::String
    module_id::Union{Nothing,String}
end
PDVNamelist(; uuid::AbstractString, filename::AbstractString,
            format::AbstractString="auto",
            module_id::Union{Nothing,AbstractString}=nothing,
            source_rel_path::Union{Nothing,AbstractString}=nothing) =
    PDVNamelist(String(uuid), String(filename),
                source_rel_path === nothing ? nothing : String(source_rel_path),
                String(format), module_id === nothing ? nothing : String(module_id))

"""
    PDVLib(; uuid, filename, module_id=nothing, source_rel_path=nothing)

Julia library file provided by a module's `lib/` branch. Lib files are
`include`d into `Main` by `pdv.modules.setup` so their exports are available
to scripts and handlers (the Julia analog of Python's `sys.path` wiring).
"""
mutable struct PDVLib <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
    module_id::Union{Nothing,String}
end
PDVLib(; uuid::AbstractString, filename::AbstractString,
       module_id::Union{Nothing,AbstractString}=nothing,
       source_rel_path::Union{Nothing,AbstractString}=nothing) =
    PDVLib(String(uuid), String(filename),
           source_rel_path === nothing ? nothing : String(source_rel_path),
           module_id === nothing ? nothing : String(module_id))

# Extensions `add_file` / `handle_file_register` autodetect as HDF5 imports.
const HDF5_EXTENSIONS = (".h5", ".hdf5")

"""
    PDVHdf5(; uuid, filename, source_rel_path=nothing)

Lazy tree node wrapping a general HDF5 file (ARCHITECTURE.md §5.8.1).

Stored as the value at a tree path (e.g. `pdv_tree["efit.data"]`). The
backing file is copied into UUID storage at import time and opened lazily
(read-only) on first access; HDF5.jl pages data from disk on demand and the
tree panel walks the group hierarchy straight from the file. Save copies the
file as-is. Construction performs no I/O.

Access from Julia code returns live HDF5.jl objects, with native slash-path
support:

    pdv_tree["efit.data"]["profiles/pressure"][:]
    pdv_tree["efit.data.profiles.pressure"]   # dot-path descent

Read-only by design — load data into memory to transform it and store
results at a normal tree path.

Requires the optional HDF5.jl package, checked when the file is first opened
(not at construction). All opens and reads happen on the main task only —
libhdf5 is not thread-safe, and the busy-time query server never touches
live tree values (see query_cache.jl, which is also where `listing_memo` is
maintained).
"""
mutable struct PDVHdf5 <: AbstractPDVFile
    uuid::String
    filename::String
    source_rel_path::Union{Nothing,String}
    handle::Any                      # HDF5.File or nothing; lazy, never serialized
    open_error::Union{Nothing,String}
    listing_memo::Any                # query-cache snapshot memo; see query_cache.jl
end
PDVHdf5(; uuid::AbstractString, filename::AbstractString,
        source_rel_path::Union{Nothing,AbstractString}=nothing) =
    PDVHdf5(String(uuid), String(filename),
            source_rel_path === nothing ? nothing : String(source_rel_path),
            nothing, nothing, nothing)

"""Return true when the HDF5 package is installed in the active environment."""
hdf5_installed()::Bool = Base.identify_package("HDF5") !== nothing

# Actionable missing-dependency message (mirror of Python's
# _dep_error_message, which names pdv.install + the pip extra).
_hdf5_dep_error_message() =
    "PDVHdf5 requires the HDF5 package, which is not installed in the " *
    "active environment. Install it with PDVKernel.install(\"HDF5\")."

"""
    preload_hdf5!()

Best-effort load of HDF5.jl on the main thread (mirror of Python's
`preimport_data_libs`): the first `Base.require` of a package must not
happen mid-listing on a code path that cannot afford it. No-op when HDF5 is
already loaded or not installed; failures are logged, never thrown.
"""
function preload_hdf5!()
    loaded_module(:HDF5) !== nothing && return nothing
    try
        hdf5_installed() || return nothing
        Base.require(Main, :HDF5)
    catch err
        @warn "Failed to pre-load HDF5" exception = err
    end
    nothing
end

"""
    open_hdf5!(node::PDVHdf5) -> HDF5.File

Open (or return the cached) backing file, read-only. Main task only. Records
`open_error` and short-circuits retries on failure — `close_hdf5!` clears it
(the retry path).

Throws when HDF5.jl is missing (with a `PDVKernel.install` hint) or the
file cannot be opened.
"""
function open_hdf5!(node::PDVHdf5)
    node.handle !== nothing && return node.handle
    hdf5 = loaded_module(:HDF5)
    if hdf5 === nothing
        hdf5_installed() || error(_hdf5_dep_error_message())
        Base.require(Main, :HDF5)  # first load must happen on the main thread
        hdf5 = loaded_module(:HDF5)
        hdf5 === nothing && error("HDF5 failed to load")
    end
    node.open_error !== nothing &&
        error("Cannot open '$(node.filename)': $(node.open_error)")
    path = resolve_path(node)
    try
        node.handle = Base.invokelatest(getproperty(hdf5, :h5open), path, "r")
    catch err
        node.open_error = sprint(showerror, err)
        error("Cannot open '$(node.filename)': $(node.open_error)")
    end
    return node.handle
end

"""
    close_hdf5!(node::PDVHdf5)

Close the cached handle (if any) and clear the recorded open error and the
query-cache listing memo. Also the retry path after a failed open.
"""
function close_hdf5!(node::PDVHdf5)
    if node.handle !== nothing
        try
            Base.invokelatest(close, node.handle)
        catch
        end
    end
    node.handle = nothing
    node.open_error = nothing
    node.listing_memo = nothing
    nothing
end
Base.close(node::PDVHdf5) = close_hdf5!(node)

# Convenience access mirroring Python's PDVHdf5.__getitem__/keys: slash
# paths resolve natively in HDF5.jl.
function Base.getindex(node::PDVHdf5, key::AbstractString)
    f = open_hdf5!(node)
    Base.invokelatest(haskey, f, String(key)) || throw(KeyError(String(key)))
    return Base.invokelatest(getindex, f, String(key))
end
Base.haskey(node::PDVHdf5, key::AbstractString) =
    try
        Base.invokelatest(haskey, open_hdf5!(node), String(key))
    catch
        false
    end
Base.keys(node::PDVHdf5) = String.(Base.invokelatest(keys, open_hdf5!(node)))

# Virtual-children adapter (dispatch replaces Python's dunder protocol).
struct PDVHdf5Adapter <: VirtualAdapter end
const _PDVHDF5_ADAPTER = PDVHdf5Adapter()
virtual_adapter(::PDVHdf5) = _PDVHDF5_ADAPTER

# Root-group members. Deeper levels are served by the foreign HDF5.Group
# adapter (virtual.jl); returned groups stay valid because they are bound to
# the cached file handle on this node.
function adapter_children(::PDVHdf5Adapter, node::PDVHdf5)::Vector{ChildEntry}
    f = open_hdf5!(node)
    ks = Base.invokelatest(keys, f)
    return ChildEntry[(String(k), Base.invokelatest(getindex, f, String(k)), nothing)
                      for k in ks]
end

function adapter_child(::PDVHdf5Adapter, node::PDVHdf5, key::String)
    f = open_hdf5!(node)
    Base.invokelatest(haskey, f, key) || throw(KeyError(key))
    return Base.invokelatest(getindex, f, key)
end

function adapter_has_children(::PDVHdf5Adapter, node::PDVHdf5)::Bool
    try
        return Base.invokelatest(length, open_hdf5!(node)) > 0
    catch
        return false
    end
end

# deepcopy must not clone the live handle/memo — the copy comes back closed
# and reopens on next access (mirror of Python's __getstate__ contract).
function Base.deepcopy_internal(node::PDVHdf5, stackdict::IdDict)
    haskey(stackdict, node) && return stackdict[node]
    new = PDVHdf5(uuid=node.uuid, filename=node.filename,
                  source_rel_path=node.source_rel_path)
    stackdict[node] = new
    return new
end

"""
    resolve_path(node::AbstractPDVFile, working_dir=nothing) -> String

Resolve the node's backing file to `<working_dir>/tree/<uuid>/<filename>`.
When `working_dir` is `nothing`, the active session tree's working directory
is used; throws if neither is available.
"""
function resolve_path(node::AbstractPDVFile,
                      working_dir::Union{Nothing,AbstractString}=nothing)::String
    wd = working_dir
    if wd === nothing
        tree = get_pdv_tree()
        wd = tree === nothing ? nothing : tree.working_dir
    end
    wd === nothing && error(
        "Cannot resolve file path: no working directory. " *
        "Pass working_dir explicitly or ensure a PDV session is active.")
    return joinpath(wd, "tree", node.uuid, node.filename)
end

"""
    preview(node) -> String

Short human-readable preview for the tree panel.
"""
preview(node::PDVFile) = node.filename
preview(node::PDVScript) = node.doc === nothing ? "" : first(split(node.doc, "\n"))
preview(node::PDVNote) = node.title === nothing ? "" : first(node.title, 100)
preview(node::PDVGui) = ""
preview(node::PDVNamelist) = node.format
preview(node::PDVLib) = node.filename
# Root item count, a dependency hint, or an unreadable marker — never throws.
# Opening on preview is deliberate Python parity: a visible node's first
# listing is where the lazy open happens.
function preview(node::PDVHdf5)
    if loaded_module(:HDF5) === nothing && !hdf5_installed()
        return "requires HDF5"
    end
    n = try
        Base.invokelatest(length, open_hdf5!(node))
    catch
        return "$(node.filename) (unreadable)"
    end
    return "$(node.filename) — $n items"
end

function Base.show(io::IO, node::AbstractPDVFile)
    print(io, nameof(typeof(node)), "(uuid=\"", node.uuid,
          "\", filename=\"", node.filename, "\")")
end

# ---------------------------------------------------------------------------
# PDVTree / PDVModule
# ---------------------------------------------------------------------------

const DEBOUNCE_INTERVAL = 0.1  # seconds

"""
    AbstractPDVTree

Supertype of `PDVTree` and `PDVModule`. Both wrap a `Dict{String,Any}` and
share the full dict interface, dot-path access, and change notification
machinery.
"""
abstract type AbstractPDVTree <: AbstractDict{String,Any} end

"""
    PDVTree()

The live project data tree — the sole authority on all project data
(ARCHITECTURE.md §5.6, §7.1). Supports dot-path access
(`tree["data.waveforms.ch1"]`) and emits `pdv.tree.changed` push
notifications on mutation when a comm is attached via [`attach_comm!`](@ref).
"""
mutable struct PDVTree <: AbstractPDVTree
    data::Dict{String,Any}
    working_dir::Union{Nothing,String}
    save_dir::Union{Nothing,String}
    send_fn::Union{Nothing,Function}
    pending_changes::Vector{Tuple{String,String}}
    debounce_timer::Union{Nothing,Timer}
    debounce_lock::ReentrantLock
end
PDVTree() = PDVTree(Dict{String,Any}(), nothing, nothing, nothing,
                    Tuple{String,String}[], nothing, ReentrantLock())

function PDVTree(pairs::AbstractDict)
    t = PDVTree()
    for (k, v) in pairs
        k isa AbstractString ||
            throw(PDVPathError("Tree keys must be strings, got $(typeof(k)): $(repr(k))"))
        set_quiet!(t, String(k), v)
    end
    return t
end

"""
    PDVModule(; module_id, name, version, gui=nothing, dependencies=[],
              description="", language="julia")

Module metadata node. A `PDVTree`-like container so it holds children
naturally (ARCHITECTURE.md §5.9).
"""
mutable struct PDVModule <: AbstractPDVTree
    data::Dict{String,Any}
    working_dir::Union{Nothing,String}
    save_dir::Union{Nothing,String}
    send_fn::Union{Nothing,Function}
    pending_changes::Vector{Tuple{String,String}}
    debounce_timer::Union{Nothing,Timer}
    debounce_lock::ReentrantLock
    module_id::String
    name::String
    version::String
    description::String
    language::String
    gui::Union{Nothing,PDVGui}
    dependencies::Vector{Dict{String,Any}}
end
function PDVModule(; module_id::AbstractString, name::AbstractString,
                   version::AbstractString, gui::Union{Nothing,PDVGui}=nothing,
                   dependencies::Union{Nothing,AbstractVector}=nothing,
                   description::AbstractString="", language::AbstractString="julia")
    deps = Dict{String,Any}[]
    if dependencies !== nothing
        for d in dependencies
            push!(deps, Dict{String,Any}(String(k) => v for (k, v) in pairs(d)))
        end
    end
    return PDVModule(Dict{String,Any}(), nothing, nothing, nothing,
                     Tuple{String,String}[], nothing, ReentrantLock(),
                     String(module_id), String(name), String(version),
                     String(description), String(language), gui, deps)
end

preview(m::PDVModule) = "$(m.name) v$(m.version)"

# ---------------------------------------------------------------------------
# Class-level "global ping" channel (non-root mutations → coarse refresh)
# ---------------------------------------------------------------------------

const _ROOT_TREE = Ref{Any}(nothing)
const _GLOBAL_SEND_FN = Ref{Any}(nothing)
const _GLOBAL_PENDING = Ref{Bool}(false)
const _GLOBAL_TIMER = Ref{Union{Nothing,Timer}}(nothing)
const _GLOBAL_LOCK = ReentrantLock()

# Monotonic mutation counter served by `pdv.tree.version` (query server).
# The renderer's safety-net poll compares this instead of re-listing every
# expanded level — one cheap round trip per tick. Bumped by every mutation
# notification and by the post-execute structural fingerprint (which catches
# plain-Dict mutations that emit nothing). Mirrors pdv-python's
# PDVTree._tree_version one-to-one.
const _TREE_VERSION = Ref{Int}(0)
const _VERSION_LOCK = ReentrantLock()
# Post-execute fingerprint state: last fingerprint of the root tree, and
# whether any mutation notification fired since the last check (drift that
# was already precisely notified doesn't fire a redundant coarse ping).
const _LAST_FINGERPRINT = Ref{Union{Nothing,UInt64}}(nothing)
const _CHANGED_SINCE_FINGERPRINT = Ref{Bool}(false)

"""Increment the tree-version counter (thread-safe)."""
function _bump_tree_version()
    lock(_VERSION_LOCK) do
        _TREE_VERSION[] += 1
    end
    nothing
end

"""Return the current tree-version counter (thread-safe)."""
get_tree_version() = lock(() -> _TREE_VERSION[], _VERSION_LOCK)

"""
    attach_comm!(tree, send_fn)

Wire `tree` as the *root tree*: its mutations emit precise per-path
notifications through `send_fn(msg_type, payload)`. Also installs `send_fn`
as the class-level fallback so any other tree instance can fire a coarse
`change_type: "unknown"` ping on mutation (ARCHITECTURE.md §7.1.2).
"""
function attach_comm!(tree::AbstractPDVTree, send_fn::Function)
    tree.send_fn = send_fn
    _ROOT_TREE[] = tree
    _GLOBAL_SEND_FN[] = send_fn
    nothing
end

"""
    detach_comm!(tree)

Detach the comm send function (e.g. on kernel restart). Clears class-level
state if this instance was the root tree.
"""
function detach_comm!(tree::AbstractPDVTree)
    tree.send_fn = nothing
    if _ROOT_TREE[] === tree
        _ROOT_TREE[] = nothing
        _GLOBAL_SEND_FN[] = nothing
        lock(_GLOBAL_LOCK) do
            if _GLOBAL_TIMER[] !== nothing
                close(_GLOBAL_TIMER[])
                _GLOBAL_TIMER[] = nothing
            end
            _GLOBAL_PENDING[] = false
        end
    end
    nothing
end

function _emit_changed(tree::AbstractPDVTree, path::String, change_type::String)
    _bump_tree_version()
    _CHANGED_SINCE_FINGERPRINT[] = true
    if _ROOT_TREE[] === tree
        tree.send_fn === nothing && return
        lock(tree.debounce_lock) do
            push!(tree.pending_changes, (path, change_type))
            if tree.debounce_timer !== nothing
                close(tree.debounce_timer)
            end
            tree.debounce_timer = Timer(DEBOUNCE_INTERVAL) do _
                _flush_changes(tree)
            end
        end
    else
        _emit_global_ping()
    end
    nothing
end

function _emit_global_ping()
    _GLOBAL_SEND_FN[] === nothing && return
    lock(_GLOBAL_LOCK) do
        _GLOBAL_PENDING[] = true
        if _GLOBAL_TIMER[] !== nothing
            close(_GLOBAL_TIMER[])
        end
        _GLOBAL_TIMER[] = Timer(DEBOUNCE_INTERVAL) do _
            _flush_global()
        end
    end
    nothing
end

function _flush_global()
    send_fn = nothing
    lock(_GLOBAL_LOCK) do
        _GLOBAL_PENDING[] || return
        _GLOBAL_PENDING[] = false
        _GLOBAL_TIMER[] = nothing
        send_fn = _GLOBAL_SEND_FN[]
    end
    send_fn === nothing && return
    try
        send_fn("pdv.tree.changed",
                Dict{String,Any}("changed_paths" => String[], "change_type" => "unknown"))
    catch err
        @warn "pdv.tree.changed global ping failed" exception = err
    end
    # Nested-PDVTree mutations reach the snapshot through this path too.
    _ROOT_TREE[] !== nothing && rebuild_query_cache!(_ROOT_TREE[])
    nothing
end

"""
    _structure_fingerprint(tree) -> UInt64

Cheap structural fingerprint of the renderer-visible tree: keys, value type
names, scalar values (whose previews show the value), and shape/length for
sized containers (whose previews show structure, not contents). Never
touches array contents, so the walk stays fast on large data. Bounded by a
node budget and depth cap. Keys are sorted so Julia's Dict iteration order
(which can change across rehashes) never affects the result. Mirrors
pdv-python's `PDVTree._structure_fingerprint`.
"""
function _structure_fingerprint(tree)::UInt64
    h = Ref(hash(UInt64(0)))
    budget = Ref(100_000)
    root = tree isa AbstractPDVTree ? tree.data : tree
    _fingerprint_walk!(h, budget, root, 0)
    return h[]
end

function _fingerprint_walk!(h::Ref{UInt64}, budget::Ref{Int}, node::AbstractDict, depth::Int)
    depth > 32 && return nothing
    for key in sort!(collect(keys(node)); by=string)
        budget[] <= 0 && return nothing
        budget[] -= 1
        value = get(node, key, nothing)
        h[] = hash(key, h[])
        inner = value isa AbstractPDVTree ? value.data : value
        if inner isa AbstractDict
            h[] = hash("{", h[])
            _fingerprint_walk!(h, budget, inner, depth + 1)
            h[] = hash("}", h[])
            continue
        end
        h[] = hash(string(typeof(value)), h[])
        if value === nothing || value isa Bool || value isa Real || value isa AbstractString
            h[] = hash(value, h[])
        elseif value isa AbstractArray
            h[] = hash(size(value), h[])
        else
            try
                h[] = hash(length(value), h[])
            catch
            end
        end
    end
    nothing
end

"""
    _post_execute_version_check() -> Nothing

Detect silent tree mutations after each execution (IJulia postexecute
hook). Plain-Dict mutations under the tree emit no change notification;
comparing a structural fingerprint before/after execution catches them. On
silent drift, the version counter is bumped and a coarse
`change_type: "unknown"` ping is emitted so the renderer refreshes
immediately. Drift that was already precisely notified only records the new
fingerprint. Mirrors pdv-python's `PDVTree._post_execute_check`.
"""
function _post_execute_version_check()
    tree = _ROOT_TREE[]
    tree === nothing && return nothing
    fingerprint = try
        _structure_fingerprint(tree)
    catch
        return nothing  # user objects can break anything; never propagate
    end
    already_notified = _CHANGED_SINCE_FINGERPRINT[]
    _CHANGED_SINCE_FINGERPRINT[] = false
    fingerprint == _LAST_FINGERPRINT[] && return nothing
    first_check = _LAST_FINGERPRINT[] === nothing
    _LAST_FINGERPRINT[] = fingerprint
    (already_notified || first_check) && return nothing
    _bump_tree_version()
    _emit_global_ping()
    nothing
end

"""
    _flush_changes(tree)

Send all pending change notifications as a single batch, deduplicating by
path (last change_type per path wins). Called by the debounce timer, or
directly in tests.
"""
function _flush_changes(tree::AbstractPDVTree)
    local pending, send_fn
    lock(tree.debounce_lock) do
        pending = tree.pending_changes
        tree.pending_changes = Tuple{String,String}[]
        tree.debounce_timer = nothing
        send_fn = tree.send_fn
    end
    (isempty(pending) || send_fn === nothing) && return
    seen = Dict{String,String}()
    order = String[]
    for (path, change_type) in pending
        haskey(seen, path) || push!(order, path)
        seen[path] = change_type
    end
    try
        send_fn("pdv.tree.changed",
                Dict{String,Any}("changed_paths" => order, "change_type" => "batch"))
    catch err
        @warn "pdv.tree.changed push failed" exception = err
    end
    # Refresh the busy-time query snapshot now that mutations settled. The
    # debounce timer runs on the main-thread scheduler, so the walk cannot
    # race MAIN-THREAD mutations — which is where cell code, script runs,
    # and comm handlers all execute. User code that writes pdv_tree from a
    # `Threads.@spawn`ed task on another thread is outside this contract:
    # Julia has no GIL, so that walk-vs-write race (a Dict mid-rehash) is
    # undefined behavior, same as any unsynchronized Dict shared across
    # threads. Documented in JULIA_KNOWN_ISSUES (#21); funneling every
    # setindex! through a shared lock would not close it anyway, because
    # nested plain Dicts are mutated directly without any PDVTree hook.
    _ROOT_TREE[] === tree && rebuild_query_cache!(tree)
    nothing
end

# ---------------------------------------------------------------------------
# Dot-path plumbing
# ---------------------------------------------------------------------------

"""
    split_dot_path(key) -> Vector{String}

Split a dot-separated tree path into segments, rejecting empty segments.
"""
function split_dot_path(key::AbstractString)::Vector{String}
    parts = String.(split(key, "."))
    for part in parts
        isempty(part) && throw(PDVPathError("Tree path contains an empty segment: '$key'"))
    end
    return parts
end

# Raw (single-segment) child access that works uniformly across PDVTree,
# PDVModule, and plain AbstractDicts — the Julia analog of Python's
# dict.__getitem__(tree, key) calls.
raw_data(t::AbstractPDVTree) = t.data
_child_has(c::AbstractPDVTree, k::String) = haskey(c.data, k)
_child_has(c::AbstractDict, k::String) = haskey(c, k)
_child_get(c::AbstractPDVTree, k::String) = c.data[k]
_child_get(c::AbstractDict, k::String) = c[k]
_child_set!(c::AbstractPDVTree, k::String, v) = (c.data[k] = v)
_child_set!(c::AbstractDict, k::String, v) = (c[k] = v)
_child_delete!(c::AbstractPDVTree, k::String) = delete!(c.data, k)
_child_delete!(c::AbstractDict, k::String) = delete!(c, k)

# Resolve a sequence index segment. Kernel-emitted sequence keys are 1-based
# (Julia convention); negative indices count from the end (-1 = last).
function _sequence_index(container, part::String)
    idx = tryparse(Int, part)
    idx === nothing && throw(KeyError(part))
    n = length(container)
    resolved = idx > 0 ? idx : (idx < 0 ? n + idx + 1 : 0)
    (resolved < 1 || resolved > n) && throw(KeyError(part))
    return resolved
end

"""
    _resolve_nested(obj, parts) -> Any

Recursively resolve path segments through nested containers: dicts by string
key, NamedTuples by field name, vectors/tuples by (1-based) integer index.
Any other value with a virtual-children adapter (a `PDVHdf5` node, a live
`HDF5.Group` — see virtual.jl) resolves the next part through
`adapter_child`, so dot-paths descend into those containers to arbitrary
depth. Throws `KeyError` on a missing segment.
"""
function _resolve_nested(obj, parts::Vector{String})
    current = obj
    for part in parts
        if current isa AbstractPDVTree || current isa AbstractDict
            _child_has(current, part) || throw(KeyError(part))
            current = _child_get(current, part)
        elseif current isa NamedTuple
            sym = Symbol(part)
            haskey(current, sym) || throw(KeyError(part))
            current = current[sym]
        elseif current isa AbstractVector || current isa Tuple
            current = current[_sequence_index(current, part)]
        else
            adapter = virtual_adapter(current)
            adapter === nothing && throw(KeyError(part))
            current = adapter_child(adapter, current, part)
        end
    end
    return current
end

# ---------------------------------------------------------------------------
# AbstractDict interface
# ---------------------------------------------------------------------------

Base.length(t::AbstractPDVTree) = length(t.data)
Base.iterate(t::AbstractPDVTree) = iterate(t.data)
Base.iterate(t::AbstractPDVTree, state) = iterate(t.data, state)
Base.isempty(t::AbstractPDVTree) = isempty(t.data)

function Base.haskey(t::AbstractPDVTree, key::AbstractString)
    parts = try
        split_dot_path(key)
    catch e
        e isa PDVPathError && return false
        rethrow()
    end
    length(parts) == 1 && return haskey(t.data, key)
    try
        _resolve_nested(t, parts)
        return true
    catch e
        # Membership must never raise (Python-parity contract): a dot-path
        # probing into an unreadable data file (open error, missing
        # dependency) is simply absent. Interrupts still propagate —
        # Python's `except Exception` never caught KeyboardInterrupt either
        # (review finding: a swallowed Ctrl-C read as "path absent").
        e isa InterruptException && rethrow()
        return false
    end
end
Base.haskey(t::AbstractPDVTree, key) = false

function Base.getindex(t::AbstractPDVTree, key::AbstractString)
    parts = split_dot_path(key)
    if length(parts) == 1
        haskey(t.data, key) && return t.data[key]
        throw(PDVKeyError(String(key)))
    end
    try
        return _resolve_nested(t, parts)
    catch e
        e isa KeyError && throw(PDVKeyError(String(key)))
        rethrow()
    end
end

function Base.get(t::AbstractPDVTree, key::AbstractString, default)
    try
        return t[key]
    catch e
        e isa PDVKeyError && return default
        rethrow()
    end
end
Base.get(t::AbstractPDVTree, key, default) = default

"""
    set_quiet!(tree, key, value)

Set a value at a dot-path without emitting notifications, creating
intermediate `PDVTree` containers as needed (and replacing non-dict
intermediates). Used by bulk loaders.
"""
function set_quiet!(t::AbstractPDVTree, key::AbstractString, value)
    parts = split_dot_path(key)
    if length(parts) == 1
        t.data[String(key)] = value
        return nothing
    end
    current = t
    for part in parts[1:end-1]
        if !_child_has(current, part) || !(_child_get(current, part) isa Union{AbstractPDVTree,AbstractDict})
            _child_set!(current, part, PDVTree())
        end
        current = _child_get(current, part)
    end
    _child_set!(current, parts[end], value)
    nothing
end

function Base.setindex!(t::AbstractPDVTree, value, key::AbstractString)
    parts = split_dot_path(key)

    # Determine which intermediate prefixes will be newly created (or
    # replaced) so their "added" events are emitted ancestors-first.
    added_prefixes = String[]
    current = t
    for i in 1:(length(parts) - 1)
        part = parts[i]
        needs_create = !_child_has(current, part) ||
                       !(_child_get(current, part) isa Union{AbstractPDVTree,AbstractDict})
        if needs_create
            for j in i:(length(parts) - 1)
                push!(added_prefixes, join(parts[1:j], "."))
            end
            break
        end
        current = _child_get(current, part)
    end

    exists = try
        haskey(t, key)
    catch
        false
    end
    change_type = exists ? "updated" : "added"
    set_quiet!(t, key, value)

    for prefix in added_prefixes
        _emit_changed(t, prefix, "added")
    end
    _emit_changed(t, String(key), change_type)
    return t
end

function Base.delete!(t::AbstractPDVTree, key::AbstractString)
    parts = split_dot_path(key)
    if length(parts) == 1
        haskey(t.data, key) || throw(PDVKeyError(String(key)))
        delete!(t.data, key)
    else
        parent = try
            _resolve_nested(t, parts[1:end-1])
        catch e
            e isa KeyError && throw(PDVKeyError(String(key)))
            rethrow()
        end
        (parent isa Union{AbstractPDVTree,AbstractDict} && _child_has(parent, parts[end])) ||
            throw(PDVKeyError(String(key)))
        _child_delete!(parent, parts[end])
    end
    _emit_changed(t, String(key), "removed")
    return t
end

function Base.pop!(t::AbstractPDVTree, key::AbstractString)
    value = try
        t[key]
    catch e
        e isa PDVKeyError && rethrow()
        rethrow()
    end
    delete!(t, key)
    return value
end
function Base.pop!(t::AbstractPDVTree, key::AbstractString, default)
    haskey(t, key) || return default
    return pop!(t, key)
end

function Base.empty!(t::AbstractPDVTree)
    ks = collect(keys(t.data))
    empty!(t.data)
    for key in ks
        _emit_changed(t, key, "removed")
    end
    return t
end

function Base.get!(t::AbstractPDVTree, key::AbstractString, default)
    haskey(t, key) || (t[key] = default)
    return t[key]
end

function Base.merge!(t::AbstractPDVTree, others::AbstractDict...)
    for other in others
        for (k, v) in pairs(other)
            t[String(k)] = v
        end
    end
    return t
end

"""
    Base.copy(t::AbstractPDVTree)

Shallow copy preserving the node's actual type and instance state. The copy
is *detached* — no comm attached — so mutating it emits no notifications
until inserted into the root tree. Values are shared (shallow).
"""
function Base.copy(t::PDVTree)
    new = PDVTree()
    new.working_dir = t.working_dir
    new.save_dir = t.save_dir
    for (k, v) in t.data
        new.data[k] = v
    end
    return new
end
function Base.copy(t::PDVModule)
    new = PDVModule(module_id=t.module_id, name=t.name, version=t.version,
                    gui=t.gui, dependencies=t.dependencies,
                    description=t.description, language=t.language)
    new.working_dir = t.working_dir
    new.save_dir = t.save_dir
    for (k, v) in t.data
        new.data[k] = v
    end
    return new
end

# deepcopy must not clone the Timer/lock/send_fn runtime plumbing — mirror of
# Python's __getstate__/__setstate__ contract: the copy comes back detached.
function Base.deepcopy_internal(t::T, stackdict::IdDict) where {T<:AbstractPDVTree}
    haskey(stackdict, t) && return stackdict[t]
    new = t isa PDVModule ?
        PDVModule(module_id=t.module_id, name=t.name, version=t.version,
                  gui=t.gui === nothing ? nothing : deepcopy(t.gui),
                  dependencies=deepcopy(t.dependencies),
                  description=t.description, language=t.language) :
        PDVTree()
    stackdict[t] = new
    new.working_dir = t.working_dir
    new.save_dir = t.save_dir
    for (k, v) in t.data
        new.data[k] = Base.deepcopy_internal(v, stackdict)
    end
    return new
end

function Base.show(io::IO, t::PDVTree)
    print(io, "PDVTree(", collect(keys(t.data)), ")")
end
Base.show(io::IO, ::MIME"text/plain", t::PDVTree) = show(io, t)
function Base.show(io::IO, m::PDVModule)
    print(io, "PDVModule(\"", m.module_id, "\", \"", m.name, "\", \"", m.version, "\")")
end
Base.show(io::IO, ::MIME"text/plain", m::PDVModule) = show(io, m)
