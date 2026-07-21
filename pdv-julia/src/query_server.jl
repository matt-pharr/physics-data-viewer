# query_server.jl — Dedicated ZeroMQ server for read-only tree/namespace queries.
#
# Port of pdv/query_server.py, with a Julia-specific twist: CPython's GIL
# lets a background OS thread read the live tree safely; Julia has neither a
# GIL nor safe concurrent Dict reads, AND a thread blocked in `ZMQ.recv`
# starves while the main thread is compute-bound (recv waits on the libuv
# event loop, which a non-yielding main thread never services — measured:
# total timeouts during a tight loop, sub-ms when idle). Two modes:
#
# - **Threaded** (kernel started with a SPARE interactive thread, the app's
#   default `--threads=auto,2`): the loop runs on an interactive-pool OS
#   thread and never touches libuv — it polls `sock.events` (a plain
#   getsockopt ccall), sleeps via `Libc.systemsleep`, and yields once per
#   tick. `pdv.tree.list` is answered from the query-cache snapshot
#   (query_cache.jl) in single-digit milliseconds even mid-computation;
#   every other query type gets a fast `query.kernel_busy` reply that the
#   app's QueryRouter converts into a comm-channel fallback (served live at
#   the next idle moment).
#
#   The pool choice is load-bearing: `@threads :static` pins one task per
#   DEFAULT-pool thread and `threading_run` waits for all of them, so a
#   poll loop occupying a default thread deadlocks every `:static` loop in
#   the session (and silently steals a compute thread besides). Interactive
#   tids are never pinned by `@threads`, so the loop lives there. The
#   per-tick `yield()` is equally load-bearing: `@spawn :interactive` may
#   start the loop on tid 1 — where the sticky root task lives — and a
#   never-yielding loop there would starve the kernel's main task outright.
#
# - **Cooperative** (no spare threads): the original async-task loop —
#   queries are served whenever the kernel task yields, and the QueryRouter's
#   timeout fallback covers compute-bound stretches.
#
# Handler replies in cooperative mode are captured via the task-local
# `:pdv_response_sink` in comms.jl, so existing handlers need no modification.

const _QUERY_ALLOWED_TYPES = Set([
    "pdv.tree.list",
    "pdv.tree.get",
    "pdv.tree.version",
    "pdv.tree.resolve_file",
    "pdv.tree.resolve_path",
    "pdv.help",
    "pdv.namespace.query",
    "pdv.namespace.inspect",
])

"""
    QueryServer(port)

ZeroMQ REP server for read-only kernel queries on `127.0.0.1:<port>`.
"""
mutable struct QueryServer
    port::Int
    shutdown::Base.Threads.Atomic{Bool}
    socket::Union{Nothing,ZMQ.Socket}
    task::Union{Nothing,Task}
    threaded::Bool
end
QueryServer(port::Integer) = QueryServer(Int(port), Base.Threads.Atomic{Bool}(false),
                                         nothing, nothing, false)

# Process one raw request payload and return the reply envelope. Pure with
# respect to sockets; never throws.
function _handle_query_request(raw::Vector{UInt8})::Dict{String,Any}
    envelope = Dict{String,Any}()
    try
        envelope = JSON.parse(String(raw))
        msg_type = get(envelope, "type", "")
        msg_id = get(envelope, "msg_id", string(UUIDs.uuid4()))

        if !(msg_type in _QUERY_ALLOWED_TYPES)
            return Dict{String,Any}(
                "pdv_version" => __pdv_protocol_version__,
                "msg_id" => string(UUIDs.uuid4()),
                "in_reply_to" => msg_id,
                "type" => "$msg_type.response",
                "status" => "error",
                "payload" => Dict{String,Any}(
                    "code" => "query.not_allowed",
                    "message" => "Message type '$msg_type' is not a read-only query"),
            )
        end

        captured = Dict{String,Any}[]
        task_local_storage(:pdv_response_sink, env -> push!(captured, env)) do
            # invokelatest: the server task's world age is frozen when the
            # task starts (at pdv.init); user packages loaded afterwards
            # would otherwise be invisible to query handlers.
            Base.invokelatest(dispatch_message, envelope)
        end

        !isempty(captured) && return captured[1]
        return Dict{String,Any}(
            "pdv_version" => __pdv_protocol_version__,
            "msg_id" => string(UUIDs.uuid4()),
            "in_reply_to" => msg_id,
            "type" => "$msg_type.response",
            "status" => "error",
            "payload" => Dict{String,Any}(
                "code" => "query.no_response",
                "message" => "Handler did not produce a response"),
        )
    catch err
        @error "QueryServer error processing message" exception = (err, catch_backtrace())
        return Dict{String,Any}(
            "pdv_version" => __pdv_protocol_version__,
            "msg_id" => string(UUIDs.uuid4()),
            "in_reply_to" => get(envelope, "msg_id", ""),
            "type" => "query.error",
            "status" => "error",
            "payload" => Dict{String,Any}(
                "code" => "query.internal_error",
                "message" => sprint(showerror, err)),
        )
    end
end

# Reply envelope for the threaded loop (which cannot go through the
# task-local response sink — it never dispatches to comm handlers).
function _threaded_reply(in_reply_to, msg_type::String, status::String,
                         payload::Dict{String,Any})::Dict{String,Any}
    return Dict{String,Any}(
        "pdv_version" => __pdv_protocol_version__,
        "msg_id" => string(UUIDs.uuid4()),
        "in_reply_to" => in_reply_to,
        "type" => "$msg_type.response",
        "status" => status,
        "payload" => payload,
    )
end

# Threaded-mode request handling: tree.list from the snapshot; everything
# else bounces with query.kernel_busy so the QueryRouter falls back to the
# comm channel. MUST NOT touch live tree values — this runs off-thread.
function _handle_threaded_query(raw::Vector{UInt8})::Dict{String,Any}
    envelope = Dict{String,Any}()
    try
        envelope = JSON.parse(String(raw))
        msg_type = get(envelope, "type", "")
        msg_id = get(envelope, "msg_id", string(UUIDs.uuid4()))

        if !(msg_type in _QUERY_ALLOWED_TYPES)
            return _threaded_reply(msg_id, msg_type, "error", Dict{String,Any}(
                "code" => "query.not_allowed",
                "message" => "Message type '$msg_type' is not a read-only query"))
        end

        if msg_type == "pdv.tree.list"
            payload = get(envelope, "payload", Dict{String,Any}())
            path = payload isa AbstractDict ? string(get(payload, "path", "")) : ""
            listing = cached_tree_listing(path)
            listing !== nothing && return _threaded_reply(
                msg_id, msg_type, "ok", Dict{String,Any}("nodes" => listing))
        end

        # The version counter is two lock-guarded Refs — safe to read
        # off-thread, and answering here keeps the renderer's poll at one
        # round trip even while the main thread is compute-bound.
        if msg_type == "pdv.tree.version"
            return _threaded_reply(msg_id, msg_type, "ok",
                Dict{String,Any}("version" => get_tree_version()))
        end

        return _threaded_reply(msg_id, msg_type, "error", Dict{String,Any}(
            "code" => "query.kernel_busy",
            "message" => "Not servable from the query snapshot; retry via comm"))
    catch err
        return _threaded_reply(get(envelope, "msg_id", ""), "query", "error",
                               Dict{String,Any}(
            "code" => "query.internal_error",
            "message" => sprint(showerror, err)))
    end
end

# Threaded mode requires an interactive-pool thread that is NOT running the
# main task — the app's `--threads=auto,2` gives exactly that. The default
# pool is off-limits (a resident loop there deadlocks `@threads :static`,
# which pins one task per default thread), and sharing the main task's only
# interactive thread would leave queries starved during compute — the exact
# situation cooperative mode already handles, without paying for a thread.
_can_run_threaded() =
    Threads.nthreads(:interactive) >=
    (Threads.threadpool() === :interactive ? 2 : 1)

"""Start the query server (threaded when a spare thread exists, else
cooperative). Idempotent while running."""
function start!(server::QueryServer)
    server.task === nothing || return nothing
    server.shutdown[] = false

    sock = ZMQ.Socket(ZMQ.REP)
    sock.linger = 0
    try
        ZMQ.bind(sock, "tcp://127.0.0.1:$(server.port)")
    catch err
        @error "QueryServer failed to bind to port $(server.port)" exception = err
        close(sock)
        return nothing
    end
    server.socket = sock

    if _can_run_threaded()
        # The socket is created on this thread and used exclusively by the
        # spawned thread from here on (the @spawn edge is the required
        # memory barrier); stop! only flags shutdown — the loop owns the
        # close. recv/send are only called when sock.events says they cannot
        # block, so the loop never enters a libuv wait. Interactive pool +
        # per-tick yield — see the pool-choice comment at the top of this
        # file; :default here deadlocks `@threads :static` (review B1).
        server.threaded = true
        server.task = Threads.@spawn :interactive begin
            try
                while !server.shutdown[]
                    events = try
                        sock.events
                    catch
                        break
                    end
                    if events & ZMQ.POLLIN != 0
                        raw = try
                            ZMQ.recv(sock)
                        catch err
                            server.shutdown[] && break
                            @error "QueryServer recv failed" exception = err
                            break
                        end
                        response = _handle_threaded_query(Vector{UInt8}(raw))
                        try
                            ZMQ.send(sock, JSON.json(response))
                        catch err
                            server.shutdown[] && break
                            @error "QueryServer send failed" exception = err
                            break
                        end
                    else
                        Libc.systemsleep(0.005)
                    end
                    # Never own the thread: if the scheduler placed this loop
                    # on the root task's tid, a tick without a yield point
                    # would starve the kernel's main task permanently.
                    yield()
                end
            finally
                try
                    close(sock)
                catch
                end
            end
        end
        @info "QueryServer started on port $(server.port) (threaded)"
        return nothing
    end

    server.task = @async begin
        try
            while !server.shutdown[]
                raw = try
                    ZMQ.recv(sock)
                catch err
                    server.shutdown[] && break
                    err isa EOFError && break
                    @error "QueryServer recv failed" exception = err
                    break
                end
                # REP contract: every recv MUST be followed by a send.
                response = _handle_query_request(Vector{UInt8}(raw))
                try
                    ZMQ.send(sock, JSON.json(response))
                catch err
                    server.shutdown[] && break
                    @error "QueryServer send failed" exception = err
                    break
                end
            end
        finally
            try
                close(sock)
            catch
            end
        end
    end
    @info "QueryServer started on port $(server.port) (cooperative)"
    nothing
end

"""Signal the server task to stop and close its socket."""
function stop!(server::QueryServer)
    server.shutdown[] = true
    if server.threaded
        # The polling thread owns the socket (ZMQ sockets are not thread-safe
        # to close from elsewhere); it notices the flag within one ~5 ms tick
        # and closes the socket in its own `finally`.
        task = server.task
        if task !== nothing
            try
                wait(task)
            catch
            end
        end
        server.socket = nothing
    elseif server.socket !== nothing
        try
            close(server.socket)  # unblocks the cooperative recv
        catch
        end
        server.socket = nothing
    end
    server.task = nothing
    @info "QueryServer stopped"
    nothing
end
