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
    _install_posterror_thread_heal_hook()

    reset_cwd_to_home()
    send_message("pdv.init.response", Dict{String,Any}(); in_reply_to=msg_id)
    nothing
end

"""
    heal_threaded_region_leak!(leaks::Integer=1) -> Bool

Decrement Base's global `jl_in_threaded_region` COUNTER by up to `leaks`,
never below zero.

Base's `threading_run` has no try/finally around its wait loop, so
interrupting a running `@threads` loop (PDV's Interrupt button / Ctrl-C)
leaks one increment for the rest of the process — after which every
`@threads :static` call errors with "cannot be used concurrently or
nested" even though nothing is running.

The value is a counter, not a flag: a user-`@spawn`ed background task
mid-`@threads` legitimately holds an increment that its own
`threading_run` will release on exit. Blindly clearing whenever nonzero
would therefore underflow the counter once that task finishes and poison
`@threads :static` PERMANENTLY (PR #347 review M3). Callers must only
pass `leaks` they can attribute to an actual leak — the posterror hook
counts interrupted `threading_run` frames; the manual escape hatch
defaults to one.

Returns true when at least one leaked increment was released (a warning
is logged so the console explains what happened).
"""
function heal_threaded_region_leak!(leaks::Integer=1)::Bool
    healed = 0
    while healed < leaks && ccall(:jl_in_threaded_region, Cint, ()) != 0
        ccall(:jl_exit_threaded_region, Cvoid, ())
        healed += 1
    end
    healed == 0 && return false
    @warn "PDV released $healed leaked threaded-region increment(s) (a " *
          "`@threads` loop was interrupted mid-run); without this, " *
          "`@threads :static` would error until the session restarts."
    return true
end

"""
    _posterror_thread_heal()

IJulia posterror hook body: heal the threaded-region counter only when the
cell's exception stack shows an `InterruptException` that unwound through
`Base.Threads.threading_run` — each such frame is exactly one leaked
increment. Posterror hooks run inside IJulia's `catch`, so
`current_exceptions()` still carries the cell's exception stack.

A plain error, an interrupt outside `@threads`, or a *background* task's
live `threading_run` (the interrupt unwinds the requests task, not the
spawned one) all leave the counter alone — the blind per-cell decrement
this replaces could underflow it (PR #347 review M3).
"""
function _posterror_thread_heal()
    leaked = 0
    for entry in current_exceptions()
        entry.exception isa InterruptException || continue
        leaked += count(frame -> frame.func === :threading_run,
                        Base.stacktrace(entry.backtrace))
    end
    leaked > 0 && heal_threaded_region_leak!(leaked)
    nothing
end

# Idempotent registration of the IJulia posterror heal hook: after a cell
# errors, release exactly the threaded-region increments an interrupted
# `@threads` run leaked so later `@threads :static` calls keep working.
const _posterror_hook_installed = Ref(false)
function _install_posterror_thread_heal_hook()
    _posterror_hook_installed[] && return nothing
    try
        IJulia.push_posterror_hook!(() -> begin
            _posterror_thread_heal()
            nothing
        end)
        _posterror_hook_installed[] = true
    catch err
        # Kernel-free sessions (tests) have no IJulia event loop.
        @debug "posterror thread-heal hook not installed" exception = err
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
