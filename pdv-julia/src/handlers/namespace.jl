# handlers/namespace.jl — Handlers for PDV namespace query messages.
#
# Port of pdv/handlers/namespace.py.

"""
    handle_namespace_query(msg)

Handle `pdv.namespace.query`: snapshot of the kernel namespace (Main's
global bindings) for the Namespace panel.
"""
function handle_namespace_query(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())

    variables = pdv_namespace(namespace_bindings();
                              include_private=get(payload, "include_private", false) == true,
                              include_modules=get(payload, "include_modules", false) == true,
                              include_callables=get(payload, "include_callables", false) == true)

    send_message("pdv.namespace.query.response",
                 Dict{String,Any}("variables" => variables); in_reply_to=msg_id)
    nothing
end

"""
    handle_namespace_inspect(msg)

Handle `pdv.namespace.inspect`: one level of child descriptors for a
namespace value addressed by `root_name` + selector `path`.
"""
function handle_namespace_inspect(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())
    root_name = string(get(payload, "root_name", ""))
    path = get(payload, "path", Any[])

    response_payload = try
        inspect_namespace(namespace_bindings(); root_name=root_name, path=path)
    catch err
        send_message("pdv.namespace.inspect.response", Dict{String,Any}(
            "error" => sprint(showerror, err),
            "children" => Any[], "truncated" => false); in_reply_to=msg_id)
        return nothing
    end

    send_message("pdv.namespace.inspect.response", response_payload; in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.namespace.query", handle_namespace_query)
register_message_handler("pdv.namespace.inspect", handle_namespace_inspect)
