# serialization.jl — Type detection and format readers/writers.
#
# Port of pdv/serialization.py. Handles all conversion between in-memory
# Julia values and on-disk file representations.
#
# Supported formats
# -----------------
# - npy  — dense numeric `Array`s (via NPZ; cross-readable with numpy)
# - jls  — Julia `Serialization` (the analog of Python's pickle)
# - txt  — plain text strings
# - inline — JSON-faithful scalars, vectors, dicts (embedded in tree-index.json)
#
# Design notes
# ------------
# - `detect_kind` returns the same kind strings as ARCHITECTURE.md §7.2.
# - `serialize_node` writes the data file and returns a node descriptor Dict
#   matching §7.3 — identical wire schema to pdv-python (the `python_type`
#   field carries the Julia type string on a Julia kernel).
# - DataFrames is optional: detection reads `Base.loaded_modules` and never
#   imports it.

# Node kind strings — must match ARCHITECTURE.md §7.2.
const KIND_FOLDER = "folder"
const KIND_SCRIPT = "script"
const KIND_NDARRAY = "ndarray"
const KIND_DATAFRAME = "dataframe"
const KIND_SERIES = "series"
const KIND_SCALAR = "scalar"
const KIND_TEXT = "text"
const KIND_MAPPING = "mapping"
const KIND_SEQUENCE = "sequence"
const KIND_MARKDOWN = "markdown"
const KIND_BINARY = "binary"
const KIND_MODULE = "module"
const KIND_GUI = "gui"
const KIND_NAMELIST = "namelist"
const KIND_LIB = "lib"
const KIND_FILE = "file"
const KIND_UNKNOWN = "unknown"

# Format strings — must match ARCHITECTURE.md §7.3 storage.format.
const FORMAT_NPY = "npy"
const FORMAT_JSON = "json"
const FORMAT_TXT = "txt"
const FORMAT_JLS = "jls"                 # Julia Serialization (pickle analog)
const FORMAT_JL_SCRIPT = "jl_script"
const FORMAT_MARKDOWN = "markdown"
const FORMAT_INLINE = "inline"
const FORMAT_GUI_JSON = "gui_json"
const FORMAT_MODULE_META = "module_meta"
const FORMAT_NAMELIST = "namelist"
const FORMAT_JL_LIB = "jl_lib"
const FORMAT_FILE = "file"
const FORMAT_BIN = "bin"

# Directory-name convention for the autosave sibling under a save dir.
const AUTOSAVE_DIR_NAME = ".autosave"

# ---------------------------------------------------------------------------
# Type detection
# ---------------------------------------------------------------------------

# Dense-array element types that round-trip through .npy (numpy-compatible).
const NPY_ELTYPES = Union{Bool,Int8,Int16,Int32,Int64,UInt8,UInt16,UInt32,UInt64,
                          Float16,Float32,Float64,ComplexF32,ComplexF64}

# Return the loaded module named `name`, or nothing — never triggers a load.
function loaded_module(name::Symbol)
    for (pkgid, mod) in Base.loaded_modules
        pkgid.name == String(name) && return mod
    end
    return nothing
end

"""Return true when `value` is a DataFrames.DataFrame and DataFrames is loaded."""
function is_dataframe(value)::Bool
    # Cheap early-out before the loaded-modules scan: detect_kind runs on
    # every node of every tree walk (checksum digests walk hundreds of
    # thousands of values through it for a single Makie figure), and scanning
    # Base.loaded_modules with a string compare per entry dominated profiles.
    nameof(typeof(value)) === :DataFrame || return false
    mod = loaded_module(:DataFrames)
    mod === nothing && return false
    return isdefined(mod, :DataFrame) && value isa mod.DataFrame
end

# Dense numeric Array (the np.ndarray analog). Vector{UInt8} is claimed by the
# binary kind (the bytes analog) before this check runs.
_is_numeric_array(value) = value isa Array && eltype(value) <: NPY_ELTYPES

"""
    julia_type_string(value) -> String

Module-qualified type string for any value (e.g. `"Core.Int64"`,
`"Main.NPendulum.PendulumSolution"`). Emitted in the descriptor field named
`python_type` for wire-schema compatibility.
"""
function julia_type_string(value)::String
    T = typeof(value)
    try
        s = string(T)
        # Types in non-root modules already print module-qualified
        # ("Main.NPendulum.PendulumSolution"); only prepend the parent module
        # when the printed form is bare ("Dict{String, Any}", "Int64").
        head = first(split(s, "{"))
        occursin(".", head) && return s
        return string(parentmodule(T)) * "." * s
    catch
        return string(T)
    end
end

"""
    detect_kind(value) -> String

Detect the node kind for a Julia value (ARCHITECTURE.md §7.2).
"""
function detect_kind(value)::String
    value isa PDVModule && return KIND_MODULE
    value isa AbstractPDVTree && return KIND_FOLDER
    value isa PDVScript && return KIND_SCRIPT
    value isa PDVNote && return KIND_MARKDOWN
    value isa PDVGui && return KIND_GUI
    value isa PDVNamelist && return KIND_NAMELIST
    value isa PDVLib && return KIND_LIB
    value isa PDVFile && return KIND_FILE
    (value === nothing || value === missing) && return KIND_SCALAR
    value isa Number && return KIND_SCALAR
    value isa AbstractString && return KIND_TEXT
    value isa Vector{UInt8} && return KIND_BINARY
    value isa AbstractDict && return KIND_MAPPING
    _is_numeric_array(value) && return KIND_NDARRAY
    (value isa AbstractVector || value isa Tuple || value isa AbstractSet) && return KIND_SEQUENCE
    is_dataframe(value) && return KIND_DATAFRAME
    return KIND_UNKNOWN
end

# ---------------------------------------------------------------------------
# Inline-JSON faithfulness
# ---------------------------------------------------------------------------

"""
    _can_inline_json(value) -> Bool

True when `value` round-trips losslessly through JSON: strings, Bool,
machine ints, finite floats, `nothing`, and Vectors/Dicts (String keys)
composed of those. Tuples, Sets, Complex, byte vectors, and non-finite
floats are rejected — they go through the `.jls` path to preserve type
fidelity (or, for NaN/Inf, to keep tree-index.json valid JSON).
"""
function _can_inline_json(value)::Bool
    value === nothing && return true
    value isa Bool && return true
    value isa AbstractString && return true
    (value isa Integer && !(value isa Bool)) &&
        return !(value isa BigInt) && typemin(Int64) <= value <= typemax(Int64)
    value isa AbstractFloat && return isfinite(value) && !(value isa BigFloat)
    if value isa Vector{UInt8}
        return false  # binary kind
    end
    if value isa AbstractVector
        _is_numeric_array(value) && return false  # ndarray kind
        return all(_can_inline_json, value)
    end
    if value isa AbstractDict
        return all(p -> (p.first isa AbstractString) && _can_inline_json(p.second), pairs(value))
    end
    return false
end

# True when value (or any nested value) is a numeric Array or DataFrame.
function _has_array_leaf(value)::Bool
    _is_numeric_array(value) && return true
    is_dataframe(value) && return true
    if value isa AbstractDict
        return any(_has_array_leaf, values(value))
    end
    if value isa AbstractVector || value isa Tuple || value isa AbstractSet
        return any(_has_array_leaf, value)
    end
    return false
end

# ---------------------------------------------------------------------------
# Previews
# ---------------------------------------------------------------------------

const _NUMPY_DTYPE_NAMES = Dict{DataType,String}(
    Bool => "bool", Int8 => "int8", Int16 => "int16", Int32 => "int32",
    Int64 => "int64", UInt8 => "uint8", UInt16 => "uint16", UInt32 => "uint32",
    UInt64 => "uint64", Float16 => "float16", Float32 => "float32",
    Float64 => "float64", ComplexF32 => "complex64", ComplexF64 => "complex128",
)
_dtype_name(T::Type) = get(_NUMPY_DTYPE_NAMES, T, string(T))

_truncate(s::AbstractString, n::Int) = length(s) <= n ? String(s) : first(s, n)

"""
    node_preview(value, kind) -> String

Short human-readable preview string for the tree panel (≤100 characters).
"""
function node_preview(value, kind::String)::String
    try
        if kind == KIND_FOLDER
            return "tree ($(length(value)) items)"
        elseif kind in (KIND_MODULE, KIND_GUI, KIND_NAMELIST, KIND_LIB, KIND_SCRIPT,
                        KIND_MARKDOWN, KIND_FILE)
            return preview(value)
        elseif kind == KIND_SCALAR
            return _truncate(string(value), 100)
        elseif kind == KIND_TEXT
            text = String(value)
            return length(text) <= 50 ? text : first(text, 50) * "..."
        elseif kind == KIND_BINARY
            return "bytes ($(length(value)) bytes)"
        elseif kind == KIND_MAPPING
            return "dict ($(length(value)) keys)"
        elseif kind == KIND_SEQUENCE
            noun = value isa Tuple ? "tuple" : value isa AbstractSet ? "set" : "vector"
            return "$noun ($(length(value)) items)"
        elseif kind == KIND_NDARRAY
            shape_str = join(string.(size(value)), " × ")
            return "$(_dtype_name(eltype(value))) array ($shape_str)"
        elseif kind == KIND_DATAFRAME
            # invokelatest: size(::DataFrame) may be newer than this frame's
            # world when DataFrames was auto-required mid project-load.
            r, c = Base.invokelatest(size, value)
            return "DataFrame ($r × $c)"
        end
    catch
    end
    # Registered serializer preview callback wins for unknown types.
    try
        entry = find_for_value(value)
        if entry !== nothing && entry.preview !== nothing
            return _truncate(string(Base.invokelatest(entry.preview, value)), 100)
        end
    catch
    end
    # Protocol pdv_preview method on the value's own type.
    if hasmethod(pdv_preview, Tuple{typeof(value)})
        try
            return _truncate(string(Base.invokelatest(pdv_preview, value)), 100)
        catch
        end
    end
    return "<unknown type>"
end

# ---------------------------------------------------------------------------
# Autosave cache plumbing (port of _try_autosave_cache and friends)
# ---------------------------------------------------------------------------

"""
    _verify_or_relocate_cached_file(descriptor, working_dir) -> Bool

Make a cache-hit descriptor's backing file reachable under `working_dir`,
moving files between a save dir and its `.autosave/` sibling when needed.
Returns false when the entry is stale and the caller must re-serialize.
See pdv-python's identically-named helper for the full rationale.
"""
function _verify_or_relocate_cached_file(descriptor::AbstractDict, working_dir::String)::Bool
    storage = get(descriptor, "storage", Dict{String,Any}())
    get(storage, "backend", "") == "local_file" || return true
    node_uuid = get(storage, "uuid", "")
    filename = get(storage, "filename", "")
    (isempty(node_uuid) || isempty(filename)) && return true

    canonical = uuid_tree_path(working_dir, node_uuid, filename)
    isfile(canonical) && return true

    working_norm = rstrip(working_dir, '/')
    is_autosave_dir = basename(working_norm) == AUTOSAVE_DIR_NAME

    if !is_autosave_dir
        # Explicit save: the file may have been written by a previous autosave.
        autosave_loc = uuid_tree_path(joinpath(working_dir, AUTOSAVE_DIR_NAME),
                                      node_uuid, filename)
        if isfile(autosave_loc)
            ensure_parent(canonical)
            try
                mv(autosave_loc, canonical; force=true)
                return true
            catch
                # Cross-device or permission failure: stage a copy atomically.
                canonical_tmp = canonical * ".tmp"
                try
                    cp(autosave_loc, canonical_tmp; force=true)
                    mv(canonical_tmp, canonical; force=true)
                    rm(autosave_loc; force=true)
                    return true
                catch
                    rm(canonical_tmp; force=true)
                    return false
                end
            end
        end
        return false
    end

    # Autosave save: the canonical file may live in the parent's tree dir.
    parent = dirname(working_norm)
    if !isempty(parent)
        parent_loc = uuid_tree_path(parent, node_uuid, filename)
        isfile(parent_loc) && return true
    end
    return false
end

const AutosaveCache = Dict{String,Tuple{Vector{UInt8},Dict}}

function _try_autosave_cache(autosave_cache::Union{Nothing,AutosaveCache},
                             tree_path::String, value, source_dir::String,
                             hit_counter::Union{Nothing,Ref{Int}},
                             working_dir::String)
    autosave_cache === nothing && return (nothing, nothing)
    digest = node_digest(value, source_dir)
    cached = get(autosave_cache, tree_path, nothing)
    if cached !== nothing && cached[1] == digest
        if _verify_or_relocate_cached_file(cached[2], working_dir)
            hit_counter !== nothing && (hit_counter[] += 1)
            return (digest, cached[2])
        end
        delete!(autosave_cache, tree_path)
    end
    return (digest, nothing)
end

# ---------------------------------------------------------------------------
# serialize_node internals
# ---------------------------------------------------------------------------

# Storage format for each file-backed node kind.
const _PDVFILE_KIND_FORMATS = Dict{String,String}(
    KIND_SCRIPT => FORMAT_JL_SCRIPT,
    KIND_MARKDOWN => FORMAT_MARKDOWN,
    KIND_GUI => FORMAT_GUI_JSON,
    KIND_LIB => FORMAT_JL_LIB,
    KIND_NAMELIST => FORMAT_NAMELIST,
    KIND_FILE => FORMAT_FILE,
)

"""Per-call state threaded through the per-kind serializer functions."""
struct SerializeContext
    tree_path::String
    key::String
    working_dir::String
    source_dir::String
    trusted::Bool
    preview::String
    autosave_cache::Union{Nothing,AutosaveCache}
    autosave_hits::Union{Nothing,Ref{Int}}
end

_utc_now_iso() = Dates.format(Dates.now(Dates.UTC), dateformat"yyyy-mm-dd\THH:MM:SS.sss") * "Z"

function _base_descriptor(tree_path::String, value, kind::String)::Dict{String,Any}
    parts = split(tree_path, ".")
    descriptor = Dict{String,Any}(
        "id" => tree_path,
        "path" => tree_path,
        "key" => String(parts[end]),
        "parent_path" => length(parts) > 1 ? join(parts[1:end-1], ".") : "",
        "type" => kind,
        "python_type" => julia_type_string(value),
        "has_children" => false,
        "updated_at" => _utc_now_iso(),
    )
    if value isa AbstractPDVFile && value.source_rel_path !== nothing
        descriptor["source_rel_path"] = value.source_rel_path
    end
    return descriptor
end

_file_storage(node_uuid::String, filename::String, fmt::String) = Dict{String,Any}(
    "backend" => "local_file", "uuid" => node_uuid,
    "filename" => filename, "format" => fmt,
)

_inline_storage(value) = Dict{String,Any}(
    "backend" => "inline", "format" => FORMAT_INLINE, "value" => value,
)

# Mint a fresh UUID target for a data node's backing file.
function _mint_data_file(ctx::SerializeContext, extension::String)
    node_uuid = generate_node_uuid()
    filename = ctx.key * extension
    file_path = uuid_tree_path(ctx.working_dir, node_uuid, filename)
    ensure_parent(file_path)
    return (node_uuid, filename, file_path)
end

"""
    _atomic_write(write, file_path)

Write a data file via a same-directory temp file + atomic rename. The temp
keeps the real filename as its suffix (`.tmp-<filename>`) so extension-
sniffing writers behave exactly as they would on the final path.
"""
function _atomic_write(write::Function, file_path::String)
    tmp_path = joinpath(dirname(file_path), ".tmp-" * basename(file_path))
    try
        write(tmp_path)
        mv(tmp_path, file_path; force=true)
    catch
        rm(tmp_path; force=true)
        rethrow()
    end
    nothing
end

_write_jls(file_path::String, value) = _atomic_write(file_path) do tmp
    open(tmp, "w") do io
        Serialization.serialize(io, value)
    end
end

"""
    _read_jls(abs_path) -> Any

Deserialize a `.jls` file, loading any packages the payload references.
Unlike Python's pickle, `Serialization.deserialize` does not auto-import
the defining package of a serialized type — it throws
`KeyError(Base.PkgId(...))` when e.g. a DataFrame is deserialized into a
session that has not loaded DataFrames. Loading the named package and
retrying reproduces pickle's implicit-import semantics for project load.
"""
function _read_jls(abs_path::String)
    for _ in 1:32  # one retry per distinct missing package, bounded
        try
            return open(Serialization.deserialize, abs_path, "r")
        catch err
            if err isa KeyError && err.key isa Base.PkgId
                Base.require(err.key)
            else
                rethrow()
            end
        end
    end
    return open(Serialization.deserialize, abs_path, "r")
end

# Shared autosave-cache pattern around a data-node write.
function _serialize_via_cache(write::Function, value, descriptor::Dict{String,Any},
                              ctx::SerializeContext)::Dict{String,Any}
    digest, cached = _try_autosave_cache(ctx.autosave_cache, ctx.tree_path, value,
                                         ctx.source_dir, ctx.autosave_hits,
                                         ctx.working_dir)
    cached !== nothing && return cached
    write()
    if digest !== nothing && ctx.autosave_cache !== nothing
        ctx.autosave_cache[ctx.tree_path] = (digest, descriptor)
    end
    return descriptor
end

# Write `value` as a .jls data file and finish `descriptor`.
function _jls_node!(value, descriptor::Dict{String,Any}, ctx::SerializeContext;
                    metadata::Union{Nothing,Dict{String,Any}}=nothing)
    node_uuid, filename, file_path = _mint_data_file(ctx, ".jls")
    _write_jls(file_path, value)
    descriptor["uuid"] = node_uuid
    descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_JLS)
    descriptor["metadata"] = metadata === nothing ?
        Dict{String,Any}("preview" => ctx.preview) : metadata
    return descriptor
end

function _serialize_folder!(value, descriptor, ctx)
    descriptor["has_children"] = true
    descriptor["storage"] = Dict{String,Any}("backend" => "none", "format" => "none")
    descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
    return descriptor
end

function _serialize_module!(value::PDVModule, descriptor, ctx)
    module_meta = Dict{String,Any}(
        "module_id" => value.module_id, "name" => value.name, "version" => value.version,
    )
    descriptor["has_children"] = true
    descriptor["storage"] = Dict{String,Any}(
        "backend" => "inline", "format" => FORMAT_MODULE_META, "value" => copy(module_meta),
    )
    descriptor["metadata"] = merge(module_meta, Dict{String,Any}("preview" => ctx.preview))
    return descriptor
end

function _file_backed_metadata(value, kind::String, preview_str::String)::Dict{String,Any}
    meta = Dict{String,Any}("preview" => preview_str)
    if kind == KIND_SCRIPT
        meta["language"] = value.language
        meta["doc"] = value.doc
    elseif kind == KIND_LIB
        meta["language"] = "julia"
        value.module_id !== nothing && !isempty(value.module_id) &&
            (meta["module_id"] = value.module_id)
    elseif kind == KIND_GUI
        value.module_id !== nothing && !isempty(value.module_id) &&
            (meta["module_id"] = value.module_id)
        meta["language"] = "json"
    elseif kind == KIND_MARKDOWN
        meta["language"] = "markdown"
        value.title !== nothing && (meta["title"] = value.title)
    elseif kind == KIND_NAMELIST
        meta["module_id"] = value.module_id
        meta["namelist_format"] = value.format
        meta["language"] = "namelist"
    end
    return meta
end

function _serialize_file_backed!(value::AbstractPDVFile, descriptor, ctx, kind::String)
    source_path = resolve_path(value, ctx.source_dir)
    isfile(source_path) ||
        throw(PDVSerializationError("File not found: $source_path"))
    dest_path = uuid_tree_path(ctx.working_dir, value.uuid, value.filename)
    if abspath(source_path) != abspath(dest_path)
        smart_copy(source_path, dest_path)
    end
    descriptor["uuid"] = value.uuid
    descriptor["storage"] = _file_storage(value.uuid, value.filename,
                                          _PDVFILE_KIND_FORMATS[kind])
    descriptor["metadata"] = _file_backed_metadata(value, kind, ctx.preview)
    return descriptor
end

function _serialize_ndarray!(value, descriptor, ctx)
    write = function ()
        node_uuid, filename, file_path = _mint_data_file(ctx, ".npy")
        _atomic_write(file_path) do tmp
            NPZ.npzwrite(tmp, value)
        end
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_NPY)
        descriptor["metadata"] = Dict{String,Any}(
            "shape" => collect(size(value)),
            "dtype" => _dtype_name(eltype(value)),
            "size_bytes" => sizeof(value),
            "preview" => ctx.preview,
        )
    end
    return _serialize_via_cache(write, value, descriptor, ctx)
end

function _serialize_dataframe!(value, descriptor, ctx)
    write = function ()
        node_uuid, filename, file_path = _mint_data_file(ctx, ".jls")
        _write_jls(file_path, value)
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_JLS)
        descriptor["metadata"] = Dict{String,Any}(
            "shape" => collect(size(value)), "preview" => ctx.preview,
        )
    end
    return _serialize_via_cache(write, value, descriptor, ctx)
end

function _serialize_scalar!(value, descriptor, ctx)
    _can_inline_json(value) || return _jls_node!(value, descriptor, ctx)
    descriptor["storage"] = _inline_storage(value)
    descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
    return descriptor
end

function _serialize_text!(value, descriptor, ctx)
    text = String(value)
    if length(text) <= 1000
        descriptor["storage"] = _inline_storage(text)
        descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
        return descriptor
    end
    write = function ()
        node_uuid, filename, file_path = _mint_data_file(ctx, ".txt")
        _atomic_write(file_path) do tmp
            open(io -> Base.write(io, text), tmp, "w")
        end
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_TXT)
        descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
    end
    return _serialize_via_cache(write, text, descriptor, ctx)
end

function _serialize_mapping!(value, descriptor, ctx)
    if _can_inline_json(value)
        descriptor["storage"] = _inline_storage(value)
        descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
        return descriptor
    end
    if !_has_array_leaf(value)
        write = () -> _jls_node!(value, descriptor, ctx)
        return _serialize_via_cache(write, value, descriptor, ctx)
    end
    # Composite container: the save walker recurses and emits per-leaf
    # descriptors so each array reaches its own fast path.
    descriptor["has_children"] = true
    descriptor["storage"] = Dict{String,Any}("backend" => "none", "format" => "none")
    descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview, "composite" => true)
    return descriptor
end

function _serialize_sequence!(value, descriptor, ctx)
    if value isa AbstractVector && _can_inline_json(value)
        descriptor["storage"] = _inline_storage(value)
        descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
        return descriptor
    end
    if !_has_array_leaf(value)
        write = () -> _jls_node!(value, descriptor, ctx)
        return _serialize_via_cache(write, value, descriptor, ctx)
    end
    throw(PDVSerializationError(
        "Sequence at '$(ctx.tree_path)' contains array leaves (numeric Array, " *
        "DataFrame). PDV does not yet support composite sequences — wrap the " *
        "values in a Dict with named keys, e.g. Dict(\"a\" => arr1, \"b\" => arr2), " *
        "so each element can be stored in its own file."))
end

function _serialize_binary!(value, descriptor, ctx)
    write = function ()
        node_uuid, filename, file_path = _mint_data_file(ctx, ".bin")
        _atomic_write(file_path) do tmp
            open(io -> Base.write(io, value), tmp, "w")
        end
        descriptor["uuid"] = node_uuid
        descriptor["storage"] = _file_storage(node_uuid, filename, FORMAT_BIN)
        descriptor["metadata"] = Dict{String,Any}("preview" => ctx.preview)
    end
    return _serialize_via_cache(write, value, descriptor, ctx)
end

function _serialize_unknown!(value, descriptor, ctx)
    write = function ()
        # 1. Registered custom serializer.
        custom = find_for_value(value)
        if custom !== nothing
            node_uuid, filename, file_path = _mint_data_file(ctx, custom.extension)
            try
                _atomic_write(tmp -> Base.invokelatest(custom.save, value, tmp), file_path)
            catch err
                throw(PDVSerializationError(
                    "Custom serializer '$(custom.type_name)' failed to save value " *
                    "at '$(ctx.tree_path)': $err"))
            end
            descriptor["uuid"] = node_uuid
            descriptor["storage"] = _file_storage(node_uuid, filename, custom.format)
            descriptor["metadata"] = Dict{String,Any}(
                "preview" => ctx.preview,
                "python_type" => julia_type_string(value),
                "serializer" => custom.type_name,
            )
            return
        end

        # 2. Protocol methods on the value's own type.
        proto = find_for_value_protocol(value)
        if proto !== nothing
            node_uuid, filename, file_path = _mint_data_file(ctx, proto.extension)
            try
                _atomic_write(tmp -> Base.invokelatest(pdv_serialize, value, tmp), file_path)
            catch err
                throw(PDVSerializationError(
                    "pdv_serialize for '$(proto.type_name)' failed to save value " *
                    "at '$(ctx.tree_path)': $err"))
            end
            descriptor["uuid"] = node_uuid
            descriptor["storage"] = _file_storage(node_uuid, filename, proto.format)
            descriptor["metadata"] = Dict{String,Any}(
                "preview" => ctx.preview,
                "python_type" => julia_type_string(value),
                "serializer" => "protocol:" * proto.type_name,
            )
            return
        end

        # 3. Julia Serialization fallback, gated on trusted.
        ctx.trusted || throw(PDVSerializationError(
            "Cannot serialize value of type '$(typeof(value))' at path " *
            "'$(ctx.tree_path)'. Register a custom serializer with " *
            "PDVKernel.register_serializer, or pass trusted=true to allow " *
            "Julia Serialization."))
        _jls_node!(value, descriptor, ctx;
                   metadata=Dict{String,Any}(
                       "preview" => ctx.preview,
                       "python_type" => julia_type_string(value)))
        return
    end
    return _serialize_via_cache(write, value, descriptor, ctx)
end

"""
    serialize_node(tree_path, value, working_dir; trusted=false, source_dir="",
                   autosave_cache=nothing, autosave_hits=nothing) -> Dict

Serialize a value to disk and return a node descriptor Dict matching
ARCHITECTURE.md §7.3. See pdv-python's `serialize_node` for the full
behavioral contract — this is a faithful port.
"""
function serialize_node(tree_path::AbstractString, value, working_dir::AbstractString;
                        trusted::Bool=false, source_dir::AbstractString="",
                        autosave_cache::Union{Nothing,AutosaveCache}=nothing,
                        autosave_hits::Union{Nothing,Ref{Int}}=nothing)::Dict{String,Any}
    kind = detect_kind(value)
    ctx = SerializeContext(
        String(tree_path),
        String(split(tree_path, ".")[end]),
        String(working_dir),
        isempty(source_dir) ? String(working_dir) : String(source_dir),
        trusted,
        node_preview(value, kind),
        autosave_cache,
        autosave_hits,
    )
    descriptor = _base_descriptor(ctx.tree_path, value, kind)

    kind == KIND_FOLDER && return _serialize_folder!(value, descriptor, ctx)
    kind == KIND_MODULE && return _serialize_module!(value, descriptor, ctx)
    haskey(_PDVFILE_KIND_FORMATS, kind) &&
        return _serialize_file_backed!(value, descriptor, ctx, kind)
    kind == KIND_NDARRAY && return _serialize_ndarray!(value, descriptor, ctx)
    kind == KIND_DATAFRAME && return _serialize_dataframe!(value, descriptor, ctx)
    kind == KIND_SCALAR && return _serialize_scalar!(value, descriptor, ctx)
    kind == KIND_TEXT && return _serialize_text!(value, descriptor, ctx)
    kind == KIND_MAPPING && return _serialize_mapping!(value, descriptor, ctx)
    kind == KIND_SEQUENCE && return _serialize_sequence!(value, descriptor, ctx)
    kind == KIND_BINARY && return _serialize_binary!(value, descriptor, ctx)
    return _serialize_unknown!(value, descriptor, ctx)
end

"""
    jls_fallback_node(tree_path, value, working_dir) -> Dict

Unconditionally write `value` as a `.jls` file and return a descriptor with
`metadata.fallback == "jls"`. Super-fallback used by the save walker when
`serialize_node` refuses a value — `project.save` must never fail because of
a single weird tree value (port of `pickle_fallback_node`).
"""
function jls_fallback_node(tree_path::AbstractString, value,
                           working_dir::AbstractString)::Dict{String,Any}
    preview_str = node_preview(value, KIND_UNKNOWN)
    ctx = SerializeContext(String(tree_path), String(split(tree_path, ".")[end]),
                           String(working_dir), String(working_dir), true,
                           preview_str, nothing, nothing)
    descriptor = _base_descriptor(ctx.tree_path, value, KIND_UNKNOWN)
    return _jls_node!(value, descriptor, ctx;
                      metadata=Dict{String,Any}(
                          "preview" => preview_str,
                          "python_type" => julia_type_string(value),
                          "fallback" => "jls"))
end

# ---------------------------------------------------------------------------
# Deserialization
# ---------------------------------------------------------------------------

"""
    deserialize_node(storage_ref, save_dir; trusted=false, value_type="") -> Any

Deserialize a value from disk given a `storage` reference Dict
(ARCHITECTURE.md §7.3). `value_type` is the descriptor's
`metadata.python_type` (a Julia type string on Julia kernels), consulted for
protocol-based custom formats.
"""
function deserialize_node(storage_ref::AbstractDict, save_dir::AbstractString;
                          trusted::Bool=false, value_type::AbstractString="")
    backend = get(storage_ref, "backend", "")

    backend == "none" && return Dict{String,Any}()
    backend == "inline" && return storage_ref["value"]

    if backend == "local_file"
        fmt = get(storage_ref, "format", "")
        node_uuid = get(storage_ref, "uuid", "")
        filename = get(storage_ref, "filename", "")
        abs_path = uuid_tree_path(save_dir, node_uuid, filename)

        isfile(abs_path) || throw(PDVSerializationError("Backing file not found: $abs_path"))

        if fmt == FORMAT_NPY
            return NPZ.npzread(abs_path)
        elseif fmt in (FORMAT_TXT, FORMAT_MARKDOWN)
            return read(abs_path, String)
        elseif fmt in (FORMAT_JSON, FORMAT_GUI_JSON)
            return JSON.parsefile(abs_path)
        elseif fmt in (FORMAT_BIN, FORMAT_FILE)
            return read(abs_path)
        elseif fmt == FORMAT_JLS
            trusted || throw(PDVSerializationError(
                "Julia Serialization deserialization is disabled. Pass trusted=true to allow it."))
            return _read_jls(abs_path)
        elseif fmt == "pickle"
            throw(PDVSerializationError(
                "Storage format 'pickle' was written by a Python kernel; this " *
                "project must be opened with a Python session."))
        end

        custom = find_for_format(fmt)
        if custom !== nothing
            try
                return Base.invokelatest(custom.load, abs_path)
            catch err
                throw(PDVSerializationError(
                    "Custom serializer '$(custom.type_name)' failed to load " *
                    "'$abs_path': $err"))
            end
        end

        if !isempty(value_type)
            # Strip type parameters before resolving (e.g. "Base.Dict{...}").
            clean = String(first(split(value_type, "{")))
            T, reason = find_for_format_protocol(fmt, clean)
            if T !== nothing
                try
                    return Base.invokelatest(pdv_deserialize, T, abs_path)
                catch err
                    throw(PDVSerializationError(
                        "pdv_deserialize for '$value_type' failed to load " *
                        "'$abs_path': $err"))
                end
            end
            if reason == LOOKUP_IMPORT_FAILED
                throw(PDVSerializationError(
                    "Unsupported storage format: '$fmt'. PDV tried to resolve " *
                    "'$value_type' to recover its pdv_deserialize method, but the " *
                    "type could not be found. Load the defining module (via the " *
                    "owning PDV module's lib, or `using`) before opening the project."))
            end
            throw(PDVSerializationError(
                "Unsupported storage format: '$fmt'. PDV resolved '$value_type' " *
                "but it does not implement pdv_deserialize — the type was likely " *
                "renamed, removed, or dropped the PDV protocol."))
        end

        throw(PDVSerializationError(
            "Unsupported storage format: '$fmt'. If this format was written by a " *
            "custom serializer, load the module that registered it before loading " *
            "the project."))
    end

    throw(PDVSerializationError("Unsupported storage backend: '$backend'"))
end
