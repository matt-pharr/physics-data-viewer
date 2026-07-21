# serializers.jl — Custom serializer registry and the PDV protocol functions.
#
# Port of pdv/serializers.py. Two extension paths for persisting instances of
# a custom type:
#
# 1. **Registered serializers.** `register_serializer(T; format, extension,
#    save, load, preview)` attaches save/load callbacks to a type the caller
#    may not own.
# 2. **Protocol methods** (Julia analog of Python's dunder protocol). A
#    package opts its own type in by adding methods to PDVKernel's generic
#    functions:
#
#        PDVKernel.pdv_format(::Type{MyType}) = ("my_fmt", ".h5")
#        PDVKernel.pdv_serialize(obj::MyType, abs_path::String) = ...
#        PDVKernel.pdv_deserialize(::Type{MyType}, abs_path::String) = MyType(...)
#
#    plus the optional `pdv_preview(obj)`, `pdv_handle(obj, path, tree)`, and
#    `pdv_digest(obj)` methods. Load-time type recovery resolves the stored
#    type string by walking module paths from `Main`.
#
# Registered serializers win over protocol methods when both exist.

# ---------------------------------------------------------------------------
# Protocol generic functions (modules add methods; PDVKernel defines none)
# ---------------------------------------------------------------------------

"""
    pdv_format(::Type{T}) -> (format_name::String, extension::String)

Protocol hook: declare the on-disk format for values of type `T`.
Required (together with [`pdv_serialize`](@ref) and [`pdv_deserialize`](@ref))
to opt a type into PDV persistence.
"""
function pdv_format end

"""
    pdv_serialize(obj, abs_path::AbstractString)

Protocol hook: write `obj`'s state to `abs_path`. PDV chooses the path.
"""
function pdv_serialize end

"""
    pdv_deserialize(::Type{T}, abs_path::AbstractString) -> T

Protocol hook: read the file written by [`pdv_serialize`](@ref) and return a
reconstructed instance.
"""
function pdv_deserialize end

"""
    pdv_preview(obj) -> String

Protocol hook: short human-readable preview shown in the tree panel.
"""
function pdv_preview end

"""
    pdv_handle(obj, path::AbstractString, tree)

Protocol hook: double-click handler for tree nodes holding values of the
method's type. The Julia analog of Python's `@pdv.handle` decorator — modules
register handlers by adding methods (see the bundled N-pendulum-julia module).
"""
function pdv_handle end

"""
    pdv_digest(obj) -> Vector{UInt8} | String

Protocol hook: stable byte payload used for change-detection checksums.
"""
function pdv_digest end

# hasmethod checks against these signatures:
_has_protocol_trio(::Type{T}) where {T} =
    hasmethod(pdv_format, Tuple{Type{T}}) &&
    hasmethod(pdv_serialize, Tuple{T,String}) &&
    hasmethod(pdv_deserialize, Tuple{Type{T},String})

# ---------------------------------------------------------------------------
# Registered serializer registry
# ---------------------------------------------------------------------------

"""One registered serializer mapping a type to save/load callbacks."""
struct SerializerEntry
    type::Type
    format::String
    extension::String
    save::Function
    load::Function
    preview::Union{Nothing,Function}
    type_name::String  # fully qualified, e.g. "Main.NPendulum.PendulumSolution"
end

const _SERIALIZER_REGISTRY = Dict{Type,SerializerEntry}()
const _FORMAT_INDEX = Dict{String,SerializerEntry}()

# Format names reserved by builtin serializers in serialization.jl. Includes
# the Python-side names too so a project can never carry an ambiguous format.
const _RESERVED_FORMATS = Set([
    "npy", "json", "txt", "pickle", "jls", "py_script", "jl_script",
    "markdown", "inline", "gui_json", "module_meta", "namelist",
    "py_lib", "jl_lib", "bin", "file", "none", "netcdf", "hdf5",
])

"""
    fully_qualified_type_name(T::Type) -> String

Return the module-qualified name of `T` (e.g. `"Main.NPendulum.PendulumSolution"`).
"""
function fully_qualified_type_name(T::Type)::String
    base = Base.unwrap_unionall(T)
    if base isa DataType
        return string(parentmodule(base)) * "." * string(nameof(base))
    end
    return string(T)
end

"""
    register_serializer(T::Type; format, extension=".bin", save, load, preview=nothing)

Register a custom serializer for instances of `T`. PDV chooses the on-disk
filename and passes an absolute path to `save(obj, abs_path)`; `load(abs_path)`
must return a reconstructed instance at project-load time. Lookup walks the
type hierarchy, so a serializer registered on an abstract type also covers
subtypes.

Throws `PDVSerializationError` when `format` is empty or collides with a
builtin format name.
"""
function register_serializer(T::Type; format::AbstractString,
                             extension::AbstractString=".bin",
                             save::Function, load::Function,
                             preview::Union{Nothing,Function}=nothing)
    isempty(format) &&
        throw(PDVSerializationError("register_serializer: 'format' must be a non-empty string"))
    format in _RESERVED_FORMATS &&
        throw(PDVSerializationError(
            "register_serializer: format '$format' collides with a builtin format name"))

    ext = isempty(extension) ? ".bin" : String(extension)
    startswith(ext, ".") || (ext = "." * ext)
    type_name = fully_qualified_type_name(T)

    fmt = String(format)
    if haskey(_FORMAT_INDEX, fmt) && _FORMAT_INDEX[fmt].type !== T
        old = _FORMAT_INDEX[fmt]
        @warn "Serializer format '$fmt' overwritten (was $(old.type_name), now $type_name)"
        delete!(_SERIALIZER_REGISTRY, old.type)
    end
    if haskey(_SERIALIZER_REGISTRY, T)
        old = _SERIALIZER_REGISTRY[T]
        @warn "Serializer for $type_name overwritten (was format '$(old.format)')"
        delete!(_FORMAT_INDEX, old.format)
    end

    entry = SerializerEntry(T, fmt, ext, save, load, preview, type_name)
    _SERIALIZER_REGISTRY[T] = entry
    _FORMAT_INDEX[fmt] = entry
    nothing
end

"""
    find_for_value(value) -> Union{SerializerEntry,Nothing}

Return the registered serializer matching `value`'s type, walking the type
hierarchy so subtypes inherit a supertype's registration.
"""
function find_for_value(value)
    T = typeof(value)
    while true
        entry = get(_SERIALIZER_REGISTRY, T, nothing)
        entry !== nothing && return entry
        T === Any && return nothing
        T = supertype(T)
    end
end

"""Return the registered serializer for `format`, or `nothing`."""
find_for_format(format::AbstractString) = get(_FORMAT_INDEX, format, nothing)

"""Return `{type_name => format}` for all registered serializers."""
get_serializer_registry() =
    Dict(entry.type_name => entry.format for entry in values(_SERIALIZER_REGISTRY))

"""Drop all registered serializers (used in tests)."""
function clear_serializers!()
    empty!(_SERIALIZER_REGISTRY)
    empty!(_FORMAT_INDEX)
    nothing
end

# ---------------------------------------------------------------------------
# Protocol lookup (value side and load side)
# ---------------------------------------------------------------------------

"""A type's protocol opt-in, synthesized from its `pdv_*` methods."""
struct ProtocolEntry
    type::Type
    format::String
    extension::String
    type_name::String
end

"""
    find_for_value_protocol(value) -> Union{ProtocolEntry,Nothing}

Return a `ProtocolEntry` when `typeof(value)` implements the full
`pdv_format` / `pdv_serialize` / `pdv_deserialize` trio, else `nothing`.

Throws `PDVSerializationError` when `pdv_format` misbehaves or its format
name collides with a builtin or a registered serializer for a different type.
"""
function find_for_value_protocol(value)
    T = typeof(value)
    _has_protocol_trio(T) || return nothing
    type_name = fully_qualified_type_name(T)

    result = try
        Base.invokelatest(pdv_format, T)
    catch err
        throw(PDVSerializationError(
            "PDV protocol for '$type_name': pdv_format() raised: $err"))
    end
    if !(result isa Tuple && length(result) == 2 &&
         result[1] isa AbstractString && result[2] isa AbstractString)
        throw(PDVSerializationError(
            "pdv_format(::Type{$type_name}) must return a 2-tuple of " *
            "(format_name::String, extension::String). Got: $(repr(result))"))
    end
    fmt, ext = String(result[1]), String(result[2])
    fmt in _RESERVED_FORMATS && throw(PDVSerializationError(
        "PDV protocol for '$type_name': format '$fmt' collides with a builtin " *
        "format name. Choose a different name in pdv_format()."))
    existing = get(_FORMAT_INDEX, fmt, nothing)
    if existing !== nothing && existing.type !== T
        throw(PDVSerializationError(
            "PDV protocol for '$type_name': format '$fmt' is already registered " *
            "via register_serializer for '$(existing.type_name)'."))
    end
    startswith(ext, ".") || (ext = "." * ext)
    return ProtocolEntry(T, fmt, ext, type_name)
end

# Failure reason codes returned by find_for_format_protocol.
const LOOKUP_OK = ""
const LOOKUP_NO_TYPE = "no_type"
const LOOKUP_IMPORT_FAILED = "import_failed"
const LOOKUP_TYPE_UNLOADABLE = "type_unloadable"

"""
    resolve_type_string(type_string) -> Union{Type,Nothing}

Resolve a dotted, module-qualified type name (e.g.
`"Main.NPendulum.PendulumSolution"`) to a live `Type`, walking `getfield`
from the named root module. Roots tried: `Main`, then any loaded package of
the first segment's name. Returns `nothing` when unresolvable.
"""
function resolve_type_string(type_string::AbstractString)
    isempty(type_string) && return nothing
    parts = split(type_string, ".")
    # Determine the root module.
    obj::Any = nothing
    rest = parts
    first_seg = Symbol(parts[1])
    if first_seg === :Main
        obj = Main
        rest = parts[2:end]
    elseif isdefined(Main, first_seg) && getfield(Main, first_seg) isa Module
        obj = getfield(Main, first_seg)
        rest = parts[2:end]
    else
        for (_, mod) in Base.loaded_modules
            if nameof(mod) === first_seg
                obj = mod
                rest = parts[2:end]
                break
            end
        end
    end
    obj === nothing && return nothing
    for part in rest
        sym = Symbol(part)
        (obj isa Module || obj isa Type) || return nothing
        isdefined(obj, sym) || return nothing
        obj = getfield(obj, sym)
    end
    return obj isa Type ? obj : nothing
end

"""
    find_for_format_protocol(fmt, type_string) -> (Union{Type,Nothing}, reason)

Recover a type implementing `pdv_deserialize` from the descriptor's stored
type string at project-load time. Never throws; returns a failure reason
code so the caller can render an actionable error.
"""
function find_for_format_protocol(fmt::AbstractString, type_string::AbstractString)
    isempty(type_string) && return (nothing, LOOKUP_NO_TYPE)
    T = try
        resolve_type_string(type_string)
    catch
        nothing
    end
    T === nothing && return (nothing, LOOKUP_IMPORT_FAILED)
    hasmethod(pdv_deserialize, Tuple{Type{T},String}) || return (nothing, LOOKUP_TYPE_UNLOADABLE)
    return (T, LOOKUP_OK)
end
