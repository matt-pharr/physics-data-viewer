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
Throws `KeyError` on a missing segment.
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
            throw(KeyError(part))
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
        (e isa KeyError || e isa MethodError || e isa BoundsError) && return false
        rethrow()
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
