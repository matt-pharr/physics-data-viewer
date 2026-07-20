# virtual.jl — Virtual-children protocol for tree nodes.
#
# Port of pdv/virtual.py. Some tree values expose *virtual* children —
# children that are browsable in the tree panel and addressable by dot-path,
# but are not real tree entries backed by PDVTree dict storage. The canonical
# example is a file-backed `PDVHdf5` node, whose children come from an
# on-demand read of the HDF5 file's group hierarchy.
#
# Two ways to participate:
# - **PDV-owned types** add a method to [`virtual_adapter`](@ref) directly —
#   multiple dispatch replaces Python's `__pdv_children__` dunder protocol
#   (see the `PDVHdf5` adapter in tree.jl).
# - **Foreign types** (objects PDVKernel does not own, e.g. `HDF5.Group`)
#   are matched by predicate through a registry of adapter instances — see
#   [`register_virtual`](@ref). Predicates use the `loaded_module` guard
#   idiom from serialization.jl so they are cheap and never trigger a
#   package load.
#
# Consumers call `virtual_adapter` and, when it returns an adapter, treat the
# value as an expandable container. The consumers are `_resolve_nested`
# (dot-path descent, tree.jl), `_list_container_nodes` / the container gate in
# `handle_tree_list` (handlers/tree.jl), and the query-cache walk
# (query_cache.jl).
#
# Foreign-object calls go through `Base.invokelatest`: HDF5 may have been
# `Base.require`d after the calling frame's world age was fixed (lazy load
# during a listing), so its methods on Base generics (`keys`, `getindex`,
# `length`, `haskey`) would otherwise be invisible to that frame.

# One virtual child: (key, live value, descriptor overrides or nothing).
# The live value is included because tree listings need it for kind
# detection, previews, and handler lookup; overrides are merged onto the
# computed node descriptor last.
const ChildEntry = Tuple{String,Any,Union{Nothing,Dict{String,Any}}}

"""
    VirtualAdapter

Supertype of adapters giving one container type virtual-children behavior.
Concrete adapters implement [`adapter_children`](@ref),
[`adapter_child`](@ref), and [`adapter_has_children`](@ref).
"""
abstract type VirtualAdapter end

"""
    adapter_children(adapter, obj) -> Vector{ChildEntry}

Return all virtual children of `obj` as `(key, value, overrides)` entries in
display order. May throw (missing dependency, unreadable file) — callers
surface those as user-facing errors.
"""
function adapter_children end

"""
    adapter_child(adapter, obj, key::String) -> Any

Return the single virtual child `key` of `obj`. Throws `KeyError` when `key`
is not a child of `obj`.
"""
function adapter_child end

"""
    adapter_has_children(adapter, obj) -> Bool

Return true when `obj` has at least one virtual child. Must be cheap and
must never throw; it is called for every sibling row on every tree listing.
"""
function adapter_has_children end

# Registry of (predicate, adapter) pairs for foreign types, checked in
# registration order. Predicates must be cheap and exception-free (the
# built-ins only probe Base.loaded_modules + isa).
const _VIRTUAL_REGISTRY = Tuple{Function,VirtualAdapter}[]

"""
    register_virtual(predicate, adapter)

Register a virtual-children adapter for a foreign container type.
`predicate(value)::Bool` must be cheap and never throw; prefer the
`loaded_module` guard idiom over importing the library the type comes from.
"""
function register_virtual(predicate::Function, adapter::VirtualAdapter)
    push!(_VIRTUAL_REGISTRY, (predicate, adapter))
    nothing
end

"""
    virtual_adapter(value) -> Union{Nothing,VirtualAdapter}

Return the virtual-children adapter for `value`, or `nothing` when `value`
has no virtual-children behavior. PDV-owned types match through their own
`virtual_adapter` method; foreign types through the registry in
registration order.
"""
function virtual_adapter(value)
    for (predicate, adapter) in _VIRTUAL_REGISTRY
        predicate(value) && return adapter
    end
    return nothing
end

# ---------------------------------------------------------------------------
# Foreign adapter: HDF5.Group / HDF5.File
# ---------------------------------------------------------------------------

"""
    Hdf5GroupAdapter

Virtual children of a live `HDF5.Group` (or `HDF5.File`): its members.
Group values only appear as virtual children served from inside an open
`PDVHdf5` node (or when a user stores a raw handle in the tree) — they are
never persisted.
"""
struct Hdf5GroupAdapter <: VirtualAdapter end

function adapter_children(::Hdf5GroupAdapter, obj)::Vector{ChildEntry}
    ks = Base.invokelatest(keys, obj)
    return ChildEntry[(String(k), Base.invokelatest(getindex, obj, String(k)), nothing)
                      for k in ks]
end

function adapter_child(::Hdf5GroupAdapter, obj, key::String)
    Base.invokelatest(haskey, obj, key) || throw(KeyError(key))
    return Base.invokelatest(getindex, obj, key)
end

function adapter_has_children(::Hdf5GroupAdapter, obj)::Bool
    try
        return Base.invokelatest(length, obj) > 0
    catch
        return false
    end
end

# `is_hdf5_group` (serialization.jl) resolves at call time — a bare function
# reference here would be an UndefVarError at include time.
register_virtual(value -> is_hdf5_group(value), Hdf5GroupAdapter())
