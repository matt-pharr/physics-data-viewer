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

    # Seed the busy-time query snapshot and keep it fresh at execution
    # boundaries: the postexecute hook catches mutations that bypass PDVTree
    # setindex! (composite plain-Dict children mutated through a held
    # reference), the same drift the renderer's 1 Hz poll corrects.
    if tree !== nothing
        rebuild_query_cache!(tree)
        _install_postexecute_cache_hook()
    end
    _install_preexecute_thread_heal_hook()

    reset_cwd_to_home()
    send_message("pdv.init.response", Dict{String,Any}(); in_reply_to=msg_id)
    nothing
end

"""
    heal_threaded_region_leak!() -> Bool

Clear Base's global `jl_in_threaded_region` flag when it has leaked.

Base's `threading_run` has no try/finally around its wait loop, so
interrupting a running `@threads` loop (PDV's Interrupt button / Ctrl-C)
leaves the flag set for the rest of the process — after which every
`@threads :static` call errors with "cannot be used concurrently or
nested" even though nothing is running. The kernel serializes cell
execution, so a set flag at cell start is that leak (the one exception —
a user-`@spawn`ed background task mid-`@threads` — is unharmed by the
clear: its `threading_run` re-clears the flag on exit anyway).

Returns true when a leak was cleared (a warning is logged so the console
explains what happened).
"""
function heal_threaded_region_leak!()::Bool
    ccall(:jl_in_threaded_region, Cint, ()) == 0 && return false
    ccall(:jl_exit_threaded_region, Cvoid, ())
    @warn "PDV cleared a leaked threaded-region flag (a previous `@threads` " *
          "loop was likely interrupted mid-run); without this, " *
          "`@threads :static` would error until the session restarts."
    return true
end

# Idempotent registration of the IJulia preexecute heal hook: runs
# heal_threaded_region_leak!() before every cell so an interrupted
# `@threads` run can't poison later `@threads :static` calls.
const _preexecute_hook_installed = Ref(false)
function _install_preexecute_thread_heal_hook()
    _preexecute_hook_installed[] && return nothing
    try
        IJulia.push_preexecute_hook!(() -> begin
            heal_threaded_region_leak!()
            nothing
        end)
        _preexecute_hook_installed[] = true
    catch err
        # Kernel-free sessions (tests) have no IJulia event loop.
        @debug "preexecute thread-heal hook not installed" exception = err
    end
    nothing
end

# Idempotent registration of the IJulia postexecute rebuild hook.
const _postexecute_hook_installed = Ref(false)
function _install_postexecute_cache_hook()
    _postexecute_hook_installed[] && return nothing
    try
        IJulia.push_postexecute_hook!(() -> begin
            tree = get_pdv_tree()
            tree !== nothing && rebuild_query_cache!(tree)
            nothing
        end)
        _postexecute_hook_installed[] = true
    catch err
        # Kernel-free sessions (tests) have no IJulia event loop — the
        # debounce-flush rebuild still keeps the snapshot fresh.
        @debug "postexecute cache hook not installed" exception = err
    end
    nothing
end

register_message_handler("pdv.init", handle_init)
