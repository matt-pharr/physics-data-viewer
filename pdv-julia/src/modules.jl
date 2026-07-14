# modules.jl — Handler registry and dispatch for custom type handlers.
#
# Port of pdv/modules.py. On a Julia kernel there are two registration paths:
#
# 1. **Multiple dispatch** (the idiomatic path, used by the bundled
#    N-pendulum-julia module): a module adds a method to PDVKernel's
#    `pdv_handle` generic function:
#
#        import PDVKernel: pdv_handle
#        function pdv_handle(obj::MyType, path::String, tree::PDVTree) ... end
#
# 2. **Explicit registration** (`register_handler(f, T)`) for wrapping types
#    the caller does not own. Registered handlers win over `pdv_handle`
#    methods, mirroring Python's registered-over-dunder precedence.
#
# Built-in default plot handlers (Python's default_handlers.py) are not
# pre-registered: Julia plotting packages provide their own `display`
# machinery, and a module's `pdv_handle` methods are the intended hook.

"""One explicitly registered handler mapping a type to a callable."""
struct HandlerEntry
    type::Type
    func::Function
    type_name::String
end

const _HANDLER_REGISTRY = Dict{Type,HandlerEntry}()

"""
    register_handler(func, T::Type)

Register `func(obj, path, tree)` as the double-click handler for values of
type `T` (and subtypes, via supertype walk). The explicit-registration analog
of adding a `pdv_handle` method; registered handlers take precedence.
"""
function register_handler(func::Function, T::Type)
    type_name = fully_qualified_type_name(T)
    if haskey(_HANDLER_REGISTRY, T)
        @warn "Handler for $type_name overwritten"
    end
    _HANDLER_REGISTRY[T] = HandlerEntry(T, func, type_name)
    nothing
end

# Walk the type hierarchy for a registered entry.
function _registered_handler_for(obj)
    T = typeof(obj)
    while true
        entry = get(_HANDLER_REGISTRY, T, nothing)
        entry !== nothing && return entry
        T === Any && return nothing
        T = supertype(T)
    end
end

"""
    has_handler_for(obj) -> Bool

True when an explicitly registered handler matches `obj`'s type, or a
`pdv_handle` method exists for it.
"""
function has_handler_for(obj)::Bool
    _registered_handler_for(obj) !== nothing && return true
    return hasmethod(pdv_handle, Tuple{typeof(obj),String,PDVTree})
end

"""
    dispatch_handler(obj, path, tree) -> Dict

Find and call the handler for `obj`. Exceptions are caught and returned as
`{"dispatched" => false, "error" => "..."}` so the renderer receives a
structured error rather than an opaque kernel exception.
"""
function dispatch_handler(obj, path::AbstractString, tree)::Dict{String,Any}
    entry = _registered_handler_for(obj)
    if entry !== nothing
        try
            Base.invokelatest(entry.func, obj, String(path), tree)
        catch err
            return Dict{String,Any}(
                "dispatched" => false,
                "error" => "Handler for $(entry.type_name) failed: $(sprint(showerror, err))")
        end
        return Dict{String,Any}("dispatched" => true)
    end
    if hasmethod(pdv_handle, Tuple{typeof(obj),String,PDVTree})
        try
            Base.invokelatest(pdv_handle, obj, String(path), tree)
        catch err
            return Dict{String,Any}(
                "dispatched" => false,
                "error" => "pdv_handle failed: $(sprint(showerror, err))")
        end
        return Dict{String,Any}("dispatched" => true)
    end
    return Dict{String,Any}(
        "dispatched" => false,
        "error" => "No handler for $(julia_type_string(obj))")
end

"""
    get_handler_registry() -> Dict{String,String}

Return `{type_name => handler_name}` for explicitly registered handlers plus
every user-defined `pdv_handle` method.
"""
function get_handler_registry()::Dict{String,String}
    registry = Dict{String,String}(
        entry.type_name => string(entry.func) for entry in values(_HANDLER_REGISTRY))
    for m in methods(pdv_handle)
        sig = Base.unwrap_unionall(m.sig)
        sig isa DataType && length(sig.parameters) >= 2 || continue
        T = sig.parameters[2]
        T isa DataType || continue
        registry[fully_qualified_type_name(T)] = "pdv_handle"
    end
    return registry
end

"""Clear the explicit handler registry (used in tests)."""
clear_handlers!() = (empty!(_HANDLER_REGISTRY); nothing)
