# query_server.jl — Dedicated ZeroMQ task for read-only tree/namespace queries.
#
# Port of pdv/query_server.py. Runs a ZMQ REP socket on an async task so
# tree browsing and namespace inspection are served whenever the kernel task
# yields (idle between executions, or at any I/O point during execution).
# Only a whitelist of read-only message types is accepted.
#
# Julia-specific note: unlike CPython (whose GIL makes a background OS thread
# safe for concurrent dict reads), a Julia task on another thread could race
# user code mutating the tree. The server therefore runs cooperatively on the
# scheduler — queries issued while user code is compute-bound without
# yielding are answered when it next yields; the app's QueryRouter falls back
# to the comm channel transparently on timeout.
#
# Handler replies are captured via the task-local `:pdv_response_sink` in
# comms.jl, so existing handlers need no modification.

const _QUERY_ALLOWED_TYPES = Set([
    "pdv.tree.list",
    "pdv.tree.get",
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
end
QueryServer(port::Integer) = QueryServer(Int(port), Base.Threads.Atomic{Bool}(false),
                                         nothing, nothing)

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

"""Start the query server task. Idempotent while running."""
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
    @info "QueryServer started on port $(server.port)"
    nothing
end

"""Signal the server task to stop and close its socket."""
function stop!(server::QueryServer)
    server.shutdown[] = true
    if server.socket !== nothing
        try
            close(server.socket)  # unblocks the recv
        catch
        end
        server.socket = nothing
    end
    server.task = nothing
    @info "QueryServer stopped"
    nothing
end
