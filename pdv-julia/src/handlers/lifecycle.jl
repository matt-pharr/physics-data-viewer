# handlers/lifecycle.jl — Handler for the pdv.init lifecycle message.
#
# Port of pdv/handlers/lifecycle.py. `pdv.ready` is emitted by the bootstrap
# snippet, not handled here.

"""
    handle_init(msg)

Handle `pdv.init`: validate and adopt the working directory, start the
QueryServer on the provided `query_port`, reset the kernel CWD to home, and
confirm with `pdv.init.response` (ARCHITECTURE.md §4.1).
"""
function handle_init(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())
    working_dir = get(payload, "working_dir", nothing)

    if working_dir === nothing || isempty(working_dir)
        send_error("pdv.init.response", "init.missing_working_dir",
                   "working_dir is required in the pdv.init payload"; in_reply_to=msg_id)
        return nothing
    end

    validated = try
        validate_working_dir(working_dir)
    catch err
        err isa PDVPathError || rethrow()
        send_error("pdv.init.response", "init.invalid_working_dir",
                   error_message(err); in_reply_to=msg_id)
        return nothing
    end

    tree = get_pdv_tree()
    tree !== nothing && (tree.working_dir = validated)

    # Start the query server if a query_port was provided.
    query_port = get(payload, "query_port", nothing)
    if query_port !== nothing
        if _query_server[] !== nothing
            stop!(_query_server[])
        end
        server = QueryServer(Int(query_port))
        start!(server)
        _query_server[] = server
    end

    reset_cwd_to_home()
    send_message("pdv.init.response", Dict{String,Any}(); in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.init", handle_init)
