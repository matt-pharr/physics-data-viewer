# PDVKernel modules — Handler registry using Julia's multiple dispatch.
#
# Module developers define:
#   PDVKernel.pdv_handle(obj::MyType, path::String, tree::PDVTree) = ...
#
# A default fallback for `Any` returns dispatched=false.
# has_handler_for() checks whether the resolved method is the Any fallback.

"""
    pdv_handle(obj, path::String, tree)

Handle a double-click on a tree node whose value is `obj`.
Module developers override this for their custom types.

The default fallback (for `Any`) returns nothing and signals no handler.
"""
function pdv_handle(obj, path::String, tree)
    return nothing  # Fallback: no handler
end

"""
    has_handler_for(obj) -> Bool

Check whether any registered handler matches `obj`'s type.
Returns true if the resolved pdv_handle method is NOT the default Any fallback.
"""
function has_handler_for(obj)::Bool
    m = which(pdv_handle, Tuple{typeof(obj), String, PDVTree})
    # Check if it's the default fallback (which has signature (::Any, ::String, ::Any))
    fallback = which(pdv_handle, Tuple{Any, String, Any})
    return m !== fallback
end

"""
    dispatch_handler(obj, path::String, tree) -> Dict

Find and call the handler for `obj`.
"""
function dispatch_handler(obj, path::String, tree)::Dict{String,Any}
    if has_handler_for(obj)
        pdv_handle(obj, path, tree)
        return Dict{String,Any}("dispatched" => true)
    end
    t = typeof(obj)
    return Dict{String,Any}(
        "dispatched" => false,
        "error" => "No handler for $t",
    )
end

"""
    get_handler_registry() -> Dict{String,String}

Return a mapping of type names to handler method signatures for all
non-fallback pdv_handle methods.
"""
function get_handler_registry()::Dict{String,String}
    result = Dict{String,String}()
    fallback = which(pdv_handle, Tuple{Any, String, Any})
    for m in methods(pdv_handle)
        if m !== fallback
            sig = m.sig
            # Extract the first parameter type (after the function itself)
            if sig isa DataType && length(sig.parameters) >= 2
                type_name = string(sig.parameters[2])
                result[type_name] = string(m)
            end
        end
    end
    return result
end
