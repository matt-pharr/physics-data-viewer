# handlers/registry.jl — PDV comm message handler dispatch table.
#
# Port of pdv/handlers/__init__.py. Handlers receive a parsed PDV message
# Dict, perform the action, and reply via send_message/send_error. Handler
# functions must not throw to the caller — dispatch_message catches and
# reports `internal.error`.

const _DISPATCH = Dict{String,Function}()

"""
    register_message_handler(msg_type, handler)

Register `handler(msg::Dict)` for a PDV message type.
"""
function register_message_handler(msg_type::AbstractString, handler::Function)
    _DISPATCH[String(msg_type)] = handler
    nothing
end

"""
    dispatch_message(msg::AbstractDict)

Dispatch a parsed PDV message envelope to its registered handler. Unknown
types get a `protocol.unknown_type` error response; handler exceptions are
caught and reported as `internal.error`.
"""
function dispatch_message(msg::AbstractDict)
    msg_type = get(msg, "type", "")
    msg_id = get(msg, "msg_id", nothing)
    handler = get(_DISPATCH, msg_type, nothing)

    response_type = isempty(msg_type) ? "pdv.unknown.response" : "$msg_type.response"
    if handler === nothing
        send_error(response_type, "protocol.unknown_type",
                   "Unknown PDV message type: '$msg_type'"; in_reply_to=msg_id)
        return nothing
    end

    try
        handler(msg)
    catch err
        message = err isa PDVException ? error_message(err) : sprint(showerror, err)
        try
            send_error(response_type, "internal.error", message; in_reply_to=msg_id)
        catch send_err
            @error "Failed to send internal.error response" exception = send_err
        end
    end
    nothing
end

# ---------------------------------------------------------------------------
# Shared validation helpers (port of handlers/_helpers.py)
# ---------------------------------------------------------------------------

"""
    validate_register_request(msg, response_type, code_prefix;
                              required_fields=("name","uuid","filename"))
        -> Union{Tuple{AbstractPDVTree,Dict},Nothing}

Validate required payload fields and resolve the live tree, sending the
appropriate error response and returning `nothing` on failure.
"""
function validate_register_request(msg::AbstractDict, response_type::AbstractString,
                                   code_prefix::AbstractString;
                                   required_fields::Tuple=("name", "uuid", "filename"))
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())

    request_name = response_type[1:end-length(".response")]
    for field in required_fields
        value = get(payload, field, nothing)
        if value === nothing || (value isa AbstractString && isempty(value))
            send_error(response_type, "$code_prefix.missing_$field",
                       "$field is required in $request_name payload";
                       in_reply_to=msg_id)
            return nothing
        end
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error(response_type, "$code_prefix.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return nothing
    end

    return (tree, payload)
end

"""
    resolve_namelist_node(msg, response_type)
        -> Union{Tuple{AbstractPDVTree,PDVNamelist,String,Dict},Nothing}

Resolve a `PDVNamelist` node from the tree for a namelist operation, sending
the appropriate error and returning `nothing` on failure.
"""
function resolve_namelist_node(msg::AbstractDict, response_type::AbstractString)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())
    tree_path = get(payload, "tree_path", "")

    if isempty(tree_path)
        request_name = response_type[1:end-length(".response")]
        send_error(response_type, "namelist.missing_tree_path",
                   "tree_path is required in $request_name payload"; in_reply_to=msg_id)
        return nothing
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error(response_type, "namelist.no_tree", "PDVTree is not initialized";
                   in_reply_to=msg_id)
        return nothing
    end

    node = try
        tree[tree_path]
    catch e
        e isa PDVKeyError || rethrow()
        send_error(response_type, "namelist.path_not_found",
                   "Tree path not found: '$tree_path'"; in_reply_to=msg_id)
        return nothing
    end

    if !(node isa PDVNamelist)
        send_error(response_type, "namelist.wrong_type",
                   "Node at '$tree_path' is not a PDVNamelist (got $(typeof(node)))";
                   in_reply_to=msg_id)
        return nothing
    end

    file_path = resolve_path(node, tree.working_dir)
    return (tree, node, file_path, payload)
end

"""
    attach_gui_to_module(tree, parent_path, gui_node)

Best-effort: set the parent `PDVModule`'s `gui` field when the parent of a
newly registered GUI node is a module.
"""
function attach_gui_to_module(tree::AbstractPDVTree, parent_path::AbstractString,
                              gui_node::PDVGui)
    isempty(parent_path) && return nothing
    parent = try
        tree[parent_path]
    catch
        return nothing
    end
    parent isa PDVModule && (parent.gui = gui_node)
    nothing
end
