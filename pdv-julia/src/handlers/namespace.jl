# PDVKernel handlers — namespace query messages.
#
# Handles:
# - pdv.namespace.query: return a snapshot of the kernel namespace.

function handle_namespace_query(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    include_private = get(payload, "include_private", false)
    include_modules = get(payload, "include_modules", false)
    include_callables = get(payload, "include_callables", false)

    variables = pdv_namespace(Main;
                              include_private=include_private,
                              include_modules=include_modules,
                              include_callables=include_callables)

    send_message("pdv.namespace.query.response",
                 Dict{String,Any}("variables" => variables); in_reply_to=msg_id)
end
