# PDVKernel tree — PDVTree, PDVFile subtypes, LazyLoadRegistry.
#
# This module is the core of PDVKernel. It implements:
# - PDVTree: an AbstractDict wrapping OrderedDict, with dot-path access,
#   lazy loading, and change notifications.
# - PDVFile: abstract base for file-backed tree nodes.
# - PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib: concrete file-backed nodes.
# - PDVModule: module metadata node (AbstractDict with children).
# - LazyLoadRegistry: internal registry for lazy-load entries.
#
# This module has NO dependency on IJulia, comms, or any Electron-facing code.

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

"""
    split_dot_path(key::String) -> Vector{String}

Split a dot-separated tree path into parts, validating each part.
"""
function split_dot_path(key::String)::Vector{String}
    parts = split(key, ".")
    for part in parts
        if isempty(part)
            throw(PDVPathError("Tree path contains an empty segment: '$key'"))
        end
    end
    return String.(parts)
end

"""
    resolve_nested(obj, parts::Vector{String})

Recursively resolve a list of path parts through nested dicts.
"""
function resolve_nested(obj, parts::Vector{String})
    current = obj
    for part in parts
        if !(current isa AbstractDict)
            throw(KeyError(part))
        end
        current = current[part]
    end
    return current
end

# ---------------------------------------------------------------------------
# LazyLoadRegistry
# ---------------------------------------------------------------------------

"""
    LazyLoadRegistry

Internal registry mapping tree paths to save-directory storage references.
Populated when a project is loaded from disk. Entries are removed once
data has been fetched into memory.
"""
mutable struct LazyLoadRegistry
    _registry::Dict{String,Dict{String,Any}}
end
LazyLoadRegistry() = LazyLoadRegistry(Dict{String,Dict{String,Any}}())

function register!(reg::LazyLoadRegistry, path::String, storage_ref::Dict)
    reg._registry[path] = storage_ref
end

function has_entry(reg::LazyLoadRegistry, path::String)::Bool
    return haskey(reg._registry, path)
end

function fetch_entry!(reg::LazyLoadRegistry, path::String, save_dir::String)
    storage_ref = pop!(reg._registry, path)
    return deserialize_node(storage_ref, save_dir; trusted=true)
end

function get_storage(reg::LazyLoadRegistry, path::String)
    return get(reg._registry, path, nothing)
end

function remove_entry!(reg::LazyLoadRegistry, path::String)
    delete!(reg._registry, path)
    return nothing
end

function entries(reg::LazyLoadRegistry)
    return [(k, v) for (k, v) in reg._registry]
end

function clear_registry!(reg::LazyLoadRegistry)
    empty!(reg._registry)
    return nothing
end

function populate_from_index!(reg::LazyLoadRegistry, nodes::Vector)
    for node in nodes
        if get(node, "lazy", false) && get(get(node, "storage", Dict()), "backend", "") == "local_file"
            register!(reg, node["path"], node["storage"])
        end
    end
end

# ---------------------------------------------------------------------------
# ScriptParameter
# ---------------------------------------------------------------------------

"""
    ScriptParameter

Descriptor for one user-facing PDVScript run() parameter.
"""
struct ScriptParameter
    name::String
    type::String
    default::Any
    required::Bool
end

function script_param_to_dict(p::ScriptParameter)::Dict{String,Any}
    return Dict{String,Any}(
        "name" => p.name,
        "type" => p.type,
        "default" => p.default,
        "required" => p.required,
    )
end

# ---------------------------------------------------------------------------
# PDVFile — abstract base for file-backed tree nodes
# ---------------------------------------------------------------------------

"""
    PDVFile

Abstract base type for file-backed PDV tree nodes.
Provides shared `relative_path` storage and `resolve_path()`.
"""
abstract type PDVFile end

"""
    relative_path(f::PDVFile) -> String

Return the relative (or absolute) path to the backing file.
"""
function relative_path end

"""
    resolve_file_path(f::PDVFile, working_dir::String) -> String

Resolve the backing file to an absolute path.
"""
function resolve_file_path(f::PDVFile, working_dir::String="")::String
    rp = relative_path(f)
    if isabspath(rp)
        return rp
    end
    if !isempty(working_dir)
        return joinpath(working_dir, rp)
    end
    return rp
end

"""
    file_preview(f::PDVFile) -> String

Return a short human-readable preview for the tree panel.
"""
function file_preview(f::PDVFile)::String
    return basename(relative_path(f))
end

# ---------------------------------------------------------------------------
# PDVScript
# ---------------------------------------------------------------------------

"""
    PDVScript

Lightweight wrapper for a script file stored as a PDV tree node.
"""
mutable struct PDVScript <: PDVFile
    _relative_path::String
    _language::String
    _doc::Union{String,Nothing}
    _params::Vector{ScriptParameter}
end

function PDVScript(relative_path::String; language::String="julia",
                   doc::Union{String,Nothing}=nothing)
    params = extract_script_params(relative_path)
    return PDVScript(relative_path, language, doc, params)
end

relative_path(s::PDVScript) = s._relative_path
language(s::PDVScript) = s._language
doc(s::PDVScript) = s._doc
params(s::PDVScript) = s._params

function file_preview(s::PDVScript)::String
    if s._doc !== nothing
        return first(split(s._doc, "\n"))
    end
    return "PDV script"
end

"""
    run_script(script::PDVScript, tree; script_path="", kwargs...)

Load and execute the script, calling its `run()` function.
Loads the module fresh on every call (no cache).

When `script_path` is provided (dot-separated tree path), the function
walks up to find a parent `PDVModule` and pre-includes any `PDVLib` nodes
from its `lib` branch into the script's execution module. This lets
scripts use `using .LibName` without manual `include()` calls, and is
forward-compatible with UUID-based file storage where filesystem paths
between scripts and libs are not predictable.
"""
function run_script(script::PDVScript, tree; script_path::String="", kwargs...)
    working_dir = get_tree_working_dir(tree)
    file_path = resolve_file_path(script, working_dir)

    if !isfile(file_path)
        throw(PDVScriptError("Script file not found: $file_path"))
    end

    # Create a fresh module within Main so it has access to Base (include, using, etc).
    # A bare Module(gensym()) is too isolated — it lacks even `include`.
    mod_name = gensym("pdv_script")
    mod = Core.eval(Main, :(module $mod_name end))

    # Pre-include module library files so scripts can `using .LibName`.
    _include_module_libs!(mod, tree, script_path, working_dir)

    try
        Base.include(mod, file_path)
    catch e
        throw(PDVScriptError("Failed to load script '$file_path': $e"))
    end

    if !isdefined(mod, :run)
        throw(PDVScriptError("Script '$(script._relative_path)' does not define a run() function"))
    end

    # JSON cannot distinguish 0 from 0.0 — coerce numeric kwargs to match
    # the script's declared keyword argument types. Re-extract params from
    # the resolved file_path since script._params may be empty (the relative
    # path doesn't exist at PDVScript construction time).
    script_params = extract_script_params(file_path)
    coerced = _coerce_kwargs(script_params, kwargs)

    try
        return Base.invokelatest(mod.run, tree; coerced...)
    catch e
        throw(PDVScriptError("Script '$(script._relative_path)' raised during run(): $e"))
    end
end

# Map of type-annotation strings to Julia types for JSON numeric coercion.
const _FLOAT_TYPES = Set(["Float64", "Float32", "Float16", "AbstractFloat"])
const _INT_TYPES   = Set(["Int", "Int64", "Int32", "Int16", "Int8",
                          "UInt", "UInt64", "UInt32", "UInt16", "UInt8", "Integer"])

"""
    _coerce_kwargs(params, kwargs) -> pairs

Coerce kwargs whose values are integers but whose declared script parameter
type is a float (or vice versa). This compensates for the JSON boundary
where `0` and `0.0` are indistinguishable.
"""
function _coerce_kwargs(params::Vector{ScriptParameter}, kwargs)
    isempty(params) && return kwargs

    # Build name → declared-type lookup
    type_map = Dict{Symbol,String}()
    for p in params
        type_map[Symbol(p.name)] = p.type
    end

    result = Dict{Symbol,Any}()
    for (k, v) in kwargs
        declared = get(type_map, k, "")
        if v isa Integer && declared in _FLOAT_TYPES
            result[k] = Float64(v)
        elseif v isa AbstractFloat && declared in _INT_TYPES
            result[k] = Int(v)
        else
            result[k] = v
        end
    end

    return pairs(result)
end

"""
    _include_module_libs!(mod::Module, tree, script_path::String, working_dir::String)

Walk up from `script_path` to find a parent PDVModule, then make all
PDVLib modules available in the script's execution module `mod`.

Libs are included into Main once (so types like PendulumSolution are
shared across script executions), then imported into the script module
via `using Main.LibName`. Scripts can use exported names directly or
qualify with `LibName.func`.
"""
function _include_module_libs!(mod::Module, tree, script_path::String, working_dir::String)
    isempty(script_path) && return

    # Walk up dot-path segments to find the parent PDVModule
    parts = split(script_path, ".")
    module_path = ""
    for i in length(parts)-1:-1:1
        candidate = join(parts[1:i], ".")
        try
            node = tree[candidate]
            if node isa PDVModule
                module_path = candidate
                break
            end
        catch
        end
    end
    isempty(module_path) && return

    # Look for the lib branch: <module_path>.lib
    lib_path = "$(module_path).lib"
    lib_branch = try tree[lib_path] catch; return end
    if !(lib_branch isa AbstractDict)
        return
    end

    # Include each PDVLib file into Main (once) then import into script module
    for (_, node) in lib_branch
        node isa PDVLib || continue
        lib_file = resolve_file_path(node, working_dir)
        isfile(lib_file) || continue

        # Determine the module name defined by the lib file (filename without .jl)
        lib_mod_name = Symbol(replace(basename(lib_file), r"\.jl$" => ""))

        # Include into Main once so types are shared across script runs
        if !isdefined(Main, lib_mod_name)
            try
                Base.include(Main, lib_file)
            catch e
                @warn "Failed to include lib '$(relative_path(node))' into Main: $e"
                continue
            end
        end

        # Import the lib's exports into the script module
        try
            Core.eval(mod, :(using Main.$lib_mod_name))
        catch e
            @warn "Failed to import Main.$lib_mod_name into script module: $e"
        end
    end
end

"""
    extract_script_params(file_path::String) -> Vector{ScriptParameter}

Extract user-facing run() params from a Julia script file via AST parsing.
Returns an empty vector if the file does not exist or has no run() function.
"""
function extract_script_params(file_path::String)::Vector{ScriptParameter}
    if !isfile(file_path)
        return ScriptParameter[]
    end

    try
        source = read(file_path, String)
        exprs = Meta.parseall(source).args

        for expr in exprs
            params = _extract_from_funcdef(expr)
            if params !== nothing
                return params
            end
        end
    catch
        # Parse error or other issue — return empty
    end

    return ScriptParameter[]
end

function _extract_from_funcdef(expr)::Union{Vector{ScriptParameter},Nothing}
    # Match `function run(pdv_tree; kwargs...)` or `run(...) = ...`
    if !(expr isa Expr)
        return nothing
    end

    # Handle both `function run(...)` and `run(...) = ...`
    if expr.head === :function || expr.head === :(=)
        call_expr = expr.args[1]
        if call_expr isa Expr && call_expr.head === :call
            fname = call_expr.args[1]
            if fname === :run || (fname isa Expr && fname.head === :(.) && fname.args[end] === QuoteNode(:run))
                return _parse_run_params(call_expr)
            end
        end
    end

    # Recurse into macrocall (e.g. docstring @doc wrapping a function def)
    if expr.head === :macrocall
        for arg in expr.args
            result = _extract_from_funcdef(arg)
            if result !== nothing
                return result
            end
        end
    end

    return nothing
end

function _parse_run_params(call_expr::Expr)::Vector{ScriptParameter}
    result = ScriptParameter[]
    args = call_expr.args[2:end]  # Skip function name

    # In Julia's AST, a `parameters` block (keyword args) appears first,
    # followed by positional args. We want to:
    # 1. Skip the first positional arg (pdv_tree)
    # 2. Collect any remaining positional args
    # 3. Collect all keyword args from the parameters block

    positional_seen = 0
    for arg in args
        if arg isa Expr && arg.head === :parameters
            # Keyword arguments block
            for kwarg in arg.args
                p = _parse_single_param(kwarg)
                if p !== nothing
                    push!(result, p)
                end
            end
        else
            positional_seen += 1
            if positional_seen == 1
                # First positional arg is pdv_tree — skip it
                continue
            end
            p = _parse_single_param(arg)
            if p !== nothing
                push!(result, p)
            end
        end
    end

    return result
end

function _parse_single_param(expr)::Union{ScriptParameter,Nothing}
    if expr isa Symbol
        return ScriptParameter(string(expr), "any", nothing, true)
    end

    if !(expr isa Expr)
        return nothing
    end

    # Handle varargs (...) — skip
    if expr.head === :...
        return nothing
    end

    # kw default: Expr(:kw, name_or_typed, default_value)
    if expr.head === :kw
        name_expr = expr.args[1]
        default_val = expr.args[2]
        name, type_str = _extract_name_type(name_expr)
        return ScriptParameter(name, type_str, default_val, false)
    end

    # Type annotation: Expr(:(::), name, type)
    if expr.head === :(::) && length(expr.args) == 2
        name = string(expr.args[1])
        type_str = string(expr.args[2])
        return ScriptParameter(name, type_str, nothing, true)
    end

    return nothing
end

function _extract_name_type(expr)::Tuple{String,String}
    if expr isa Symbol
        return (string(expr), "any")
    end
    if expr isa Expr && expr.head === :(::) && length(expr.args) == 2
        return (string(expr.args[1]), string(expr.args[2]))
    end
    return (string(expr), "any")
end

# ---------------------------------------------------------------------------
# PDVNote
# ---------------------------------------------------------------------------

"""
    PDVNote

Lightweight wrapper for a markdown note file stored as a PDV tree node.
"""
mutable struct PDVNote <: PDVFile
    _relative_path::String
    _title::Union{String,Nothing}
end

PDVNote(relative_path::String; title::Union{String,Nothing}=nothing) =
    PDVNote(relative_path, title)

relative_path(n::PDVNote) = n._relative_path
title(n::PDVNote) = n._title

function file_preview(n::PDVNote)::String
    if n._title !== nothing
        return first(n._title, 100)
    end
    try
        if isfile(n._relative_path)
            for line in eachline(n._relative_path)
                stripped = lstrip(line)
                stripped = lstrip(stripped, '#')
                stripped = strip(stripped)
                if !isempty(stripped)
                    return first(stripped, 100)
                end
            end
        end
    catch
    end
    return "Markdown note"
end

# ---------------------------------------------------------------------------
# PDVGui
# ---------------------------------------------------------------------------

"""
    PDVGui

File-backed GUI definition node.
"""
mutable struct PDVGui <: PDVFile
    _relative_path::String
    _module_id::Union{String,Nothing}
end

PDVGui(relative_path::String; module_id::Union{String,Nothing}=nothing) =
    PDVGui(relative_path, module_id)

relative_path(g::PDVGui) = g._relative_path
module_id(g::PDVGui) = g._module_id

file_preview(::PDVGui) = "GUI"

# ---------------------------------------------------------------------------
# PDVNamelist
# ---------------------------------------------------------------------------

"""
    PDVNamelist

File-backed namelist node. Knows its format for parsing dispatch.
"""
mutable struct PDVNamelist <: PDVFile
    _relative_path::String
    _format::String  # "fortran", "toml", "auto"
    _module_id::Union{String,Nothing}
end

PDVNamelist(relative_path::String; format::String="auto",
            module_id::Union{String,Nothing}=nothing) =
    PDVNamelist(relative_path, format, module_id)

relative_path(n::PDVNamelist) = n._relative_path
namelist_format(n::PDVNamelist) = n._format
module_id(n::PDVNamelist) = n._module_id

file_preview(n::PDVNamelist) = "Namelist ($(n._format))"

# ---------------------------------------------------------------------------
# PDVLib
# ---------------------------------------------------------------------------

"""
    PDVLib

File-backed Julia library file provided by a module.
"""
mutable struct PDVLib <: PDVFile
    _relative_path::String
    _module_id::Union{String,Nothing}
end

PDVLib(relative_path::String; module_id::Union{String,Nothing}=nothing) =
    PDVLib(relative_path, module_id)

relative_path(l::PDVLib) = l._relative_path
module_id(l::PDVLib) = l._module_id

file_preview(l::PDVLib) = "Library ($(basename(l._relative_path)))"

# ---------------------------------------------------------------------------
# PDVHDF5
# ---------------------------------------------------------------------------

"""
    PDVHDF5

File-backed HDF5 browsing node. Lazily reads HDF5 groups/datasets
when expanded in the tree viewer. Read-only initially.
"""
mutable struct PDVHDF5 <: PDVFile
    _relative_path::String
    _hdf5_path::String  # Internal HDF5 path (e.g., "/group1/subgroup")
end

PDVHDF5(relative_path::String; hdf5_path::String="/") =
    PDVHDF5(relative_path, hdf5_path)

relative_path(h::PDVHDF5) = h._relative_path
hdf5_path(h::PDVHDF5) = h._hdf5_path

file_preview(::PDVHDF5) = "HDF5"

# ---------------------------------------------------------------------------
# PDVTree
# ---------------------------------------------------------------------------

"""
    PDVTree <: AbstractDict{String,Any}

The live project data tree. The sole authority on all project data.
Wraps an OrderedDict with dot-path access, lazy loading, and change notifications.
"""
mutable struct PDVTree <: AbstractDict{String,Any}
    _data::OrderedDict{String,Any}
    _lazy_registry::LazyLoadRegistry
    _working_dir::Union{String,Nothing}
    _save_dir::Union{String,Nothing}
    _send_fn::Union{Function,Nothing}
    _path_prefix::String
end

function PDVTree(; data::OrderedDict{String,Any}=OrderedDict{String,Any}())
    return PDVTree(data, LazyLoadRegistry(), nothing, nothing, nothing, "")
end

function PDVTree(pairs::Pair{String}...)
    d = OrderedDict{String,Any}(pairs...)
    return PDVTree(data=d)
end

# Internal state management
function set_working_dir!(tree::PDVTree, path::String)
    tree._working_dir = path
end

function set_save_dir!(tree::PDVTree, path::Union{String,Nothing})
    tree._save_dir = path
end

function attach_comm!(tree::PDVTree, send_fn::Function)
    tree._send_fn = send_fn
end

function detach_comm!(tree::PDVTree)
    tree._send_fn = nothing
end

function get_tree_working_dir(tree::PDVTree)::String
    return something(tree._working_dir, "")
end

function emit_changed!(tree::PDVTree, path::String, change_type::String)
    if tree._send_fn !== nothing
        tree._send_fn(
            "pdv.tree.changed",
            Dict{String,Any}("changed_paths" => [path], "change_type" => change_type),
        )
    end
end

# AbstractDict interface — includes lazy entries at this tree level.

function _lazy_child_keys(t::PDVTree)::Vector{String}
    prefix = t._path_prefix
    result = String[]
    for (reg_path, _) in entries(t._lazy_registry)
        parts = split(reg_path, ".")
        if isempty(prefix)
            # Root tree: direct children have exactly 1 part
            if length(parts) == 1 && !haskey(t._data, parts[1])
                push!(result, parts[1])
            end
        else
            # Subtree: entries that start with prefix and have exactly one more segment
            pp = split(prefix, ".")
            if length(parts) == length(pp) + 1 && join(parts[1:length(pp)], ".") == prefix
                k = String(parts[end])
                if !haskey(t._data, k)
                    push!(result, k)
                end
            end
        end
    end
    return result
end

function Base.keys(t::PDVTree)
    materialized = collect(keys(t._data))
    lazy = _lazy_child_keys(t)
    isempty(lazy) ? materialized : vcat(materialized, lazy)
end

Base.length(t::PDVTree) = length(keys(t))
Base.iterate(t::PDVTree) = _iterate_tree(t, nothing)
Base.iterate(t::PDVTree, state) = _iterate_tree(t, state)
Base.values(t::PDVTree) = [t[k] for k in keys(t)]

function _iterate_tree(t::PDVTree, state)
    ks = keys(t)
    idx = state === nothing ? 1 : state
    idx > length(ks) && return nothing
    k = ks[idx]
    return (k => t[k], idx + 1)
end

function Base.haskey(t::PDVTree, key::String)::Bool
    parts = try
        split_dot_path(key)
    catch
        return false
    end
    full_key = isempty(t._path_prefix) ? key : "$(t._path_prefix).$key"

    if length(parts) == 1
        return haskey(t._data, key) || has_entry(t._lazy_registry, full_key)
    end
    if has_entry(t._lazy_registry, full_key)
        return true
    end
    try
        resolve_nested(t, parts)
        return true
    catch
        return false
    end
end

# Support `key in tree`
Base.in(key::String, t::PDVTree) = haskey(t, key)

function Base.getindex(t::PDVTree, key::String)
    parts = split_dot_path(key)
    full_key = isempty(t._path_prefix) ? key : "$(t._path_prefix).$key"

    if length(parts) == 1
        p = parts[1]
        if haskey(t._data, p)
            return t._data[p]
        end
        if has_entry(t._lazy_registry, full_key)
            val = fetch_entry!(t._lazy_registry, full_key, something(t._save_dir, ""))
            t._data[p] = val
            return val
        end
        throw(PDVKeyError(key))
    end

    # Multi-part: check full path in lazy registry first
    if has_entry(t._lazy_registry, full_key)
        val = fetch_entry!(t._lazy_registry, full_key, something(t._save_dir, ""))
        # Store value at the leaf position
        parent = t
        for part in parts[1:end-1]
            if !haskey(parent._data, part)
                new_node = PDVTree()
                new_node._lazy_registry = t._lazy_registry
                parent._data[part] = new_node
            end
            parent = parent._data[part]
        end
        if parent isa PDVTree
            parent._data[parts[end]] = val
        end
        return val
    end

    # Navigate through nested dicts
    try
        return resolve_nested(t, parts)
    catch e
        if e isa KeyError
            throw(PDVKeyError(key))
        end
        rethrow()
    end
end

function Base.setindex!(t::PDVTree, value, key::String)
    parts = split_dot_path(key)

    # Determine change_type
    change_type = haskey(t, key) ? "updated" : "added"

    if length(parts) == 1
        t._data[key] = value
    else
        current = t
        for part in parts[1:end-1]
            if current isa PDVTree
                data = current._data
            elseif current isa PDVModule
                data = current._children._data
            else
                error("Cannot set child '$part' on non-dict node $(typeof(current))")
            end

            if !haskey(data, part)
                new_node = PDVTree()
                new_node._lazy_registry = t._lazy_registry
                data[part] = new_node
            end
            node = data[part]
            if !(node isa Union{PDVTree, PDVModule})
                new_node = PDVTree()
                new_node._lazy_registry = t._lazy_registry
                data[part] = new_node
                node = new_node
            end
            current = node
        end

        # Set the leaf value
        if current isa PDVTree
            current._data[parts[end]] = value
        elseif current isa PDVModule
            current._children._data[parts[end]] = value
        end
    end

    emit_changed!(t, key, change_type)
end

function Base.delete!(t::PDVTree, key::String)
    parts = split_dot_path(key)
    full_key = isempty(t._path_prefix) ? key : "$(t._path_prefix).$key"
    in_registry = has_entry(t._lazy_registry, full_key)

    if length(parts) == 1
        p = parts[1]
        if !haskey(t._data, p) && !in_registry
            throw(PDVKeyError(key))
        end
        if haskey(t._data, p)
            delete!(t._data, p)
        end
        if in_registry
            remove_entry!(t._lazy_registry, full_key)
        end
    else
        if in_registry
            remove_entry!(t._lazy_registry, full_key)
        end
        try
            parent = t
            for part in parts[1:end-1]
                parent = parent._data[part]
            end
            if haskey(parent._data, parts[end])
                delete!(parent._data, parts[end])
            elseif !in_registry
                throw(PDVKeyError(key))
            end
        catch e
            if e isa PDVKeyError
                rethrow()
            end
            if !in_registry
                throw(PDVKeyError(key))
            end
        end
    end

    emit_changed!(t, key, "removed")
    return t
end

# get() with default — used for safe lookup
function Base.get(t::PDVTree, key::String, default)
    try
        return t[key]
    catch e
        if e isa PDVKeyError
            return default
        end
        rethrow()
    end
end

# Public API
has_lazy_entry(t::PDVTree, path::String) = has_entry(t._lazy_registry, path)
lazy_storage_for(t::PDVTree, path::String) = get_storage(t._lazy_registry, path)
iter_lazy_entries(t::PDVTree) = entries(t._lazy_registry)

"""
    run_script(tree::PDVTree, script_path::String; kwargs...)

Execute a script stored in the tree.
"""
function run_tree_script(tree::PDVTree, script_path::String; kwargs...)
    node = tree[script_path]
    if !(node isa PDVScript)
        throw(TypeError("Node at '$script_path' is not a PDVScript (got $(typeof(node)))"))
    end
    return run_script(node, tree; script_path=script_path, kwargs...)
end

function Base.show(io::IO, t::PDVTree)
    ks = collect(keys(t._data))
    print(io, "PDVTree(", ks, ")")
end

# ---------------------------------------------------------------------------
# PDVModule
# ---------------------------------------------------------------------------

"""
    PDVModule <: AbstractDict{String,Any}

Module metadata node. Contains a PDVTree for children.
"""
mutable struct PDVModule <: AbstractDict{String,Any}
    _module_id::String
    _name::String
    _version::String
    _gui::Union{PDVGui,Nothing}
    _children::PDVTree
end

function PDVModule(module_id::String, name::String, version::String;
                   gui::Union{PDVGui,Nothing}=nothing)
    return PDVModule(module_id, name, version, gui, PDVTree())
end

module_id(m::PDVModule) = m._module_id
module_name(m::PDVModule) = m._name
module_version(m::PDVModule) = m._version
module_gui(m::PDVModule) = m._gui
set_gui!(m::PDVModule, gui::Union{PDVGui,Nothing}) = (m._gui = gui)

# Forward AbstractDict to children
Base.length(m::PDVModule) = length(m._children)
Base.iterate(m::PDVModule) = iterate(m._children)
Base.iterate(m::PDVModule, state) = iterate(m._children, state)
Base.keys(m::PDVModule) = keys(m._children)
Base.values(m::PDVModule) = values(m._children)
Base.haskey(m::PDVModule, key::String) = haskey(m._children, key)
Base.getindex(m::PDVModule, key::String) = m._children[key]
Base.setindex!(m::PDVModule, value, key::String) = (m._children[key] = value)
Base.delete!(m::PDVModule, key::String) = delete!(m._children, key)
Base.get(m::PDVModule, key::String, default) = get(m._children, key, default)

# Expose internal PDVTree for lazy registry sharing
children_tree(m::PDVModule) = m._children

function file_preview(m::PDVModule)::String
    return "$(m._name) v$(m._version)"
end

function Base.show(io::IO, m::PDVModule)
    print(io, "PDVModule('$(m._module_id)', '$(m._name)', '$(m._version)')")
end
