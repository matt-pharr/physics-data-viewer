# comms.jl — PDV comm channel state, message dispatch, and sending.
#
# Port of pdv/comms.py. The kernel-side comm layer:
#
# 1. Holds the comm opened by the bootstrap snippet (see JULIA_BOOTSTRAP in
#    electron/main/kernel-session.ts — the app executes it after spawn).
# 2. Receives incoming comm messages and dispatches them to the registered
#    handler (handlers/registry.jl).
# 3. Provides `send_message` for building and sending correctly enveloped
#    PDV messages back to the app (ARCHITECTURE.md §3.2).
#
# Tests stub the transport by setting `_send_override[]`; the query server
# captures handler replies via a task-local response sink.

const PDV_COMM_TARGET = "pdv.kernel"

# The single global comm instance (assigned by the bootstrap snippet).
const _comm = Ref{Any}(nothing)
# Flag preventing double-bootstrap.
const _bootstrapped = Ref{Bool}(false)
# The live PDVTree (set by bootstrap).
const _pdv_tree = Ref{Any}(nothing)
# The running QueryServer (set on pdv.init).
const _query_server = Ref{Any}(nothing)
# Test hook: when set, envelopes are handed to this function instead of the comm.
const _send_override = Ref{Any}(nothing)

"""Return the global PDVTree instance, or `nothing` before bootstrap."""
get_pdv_tree() = _pdv_tree[]

const _CORE_VERSION_RE = r"^(\d+)\.(\d+)\.(\d+)"

# Leading major.minor.patch of a version string (prerelease suffix dropped).
function _core_version(v::AbstractString)::String
    m = match(_CORE_VERSION_RE, v)
    m === nothing && return String(v)
    return "$(m.captures[1]).$(m.captures[2]).$(m.captures[3])"
end

"""
    send_message(msg_type, payload; status="ok", in_reply_to=nothing)

Send a PDV message from the kernel to the app using the standard envelope
(ARCHITECTURE.md §3.2). On the query-server task the envelope is routed to
the task-local response sink instead of the comm channel.
"""
function send_message(msg_type::AbstractString, payload::AbstractDict;
                      status::AbstractString="ok",
                      in_reply_to::Union{Nothing,AbstractString}=nothing)
    envelope = Dict{String,Any}(
        "pdv_version" => __pdv_protocol_version__,
        "msg_id" => string(UUIDs.uuid4()),
        "in_reply_to" => in_reply_to,
        "type" => String(msg_type),
        "status" => String(status),
        "payload" => payload,
    )
    sink = get(task_local_storage(), :pdv_response_sink, nothing)
    if sink !== nothing
        sink(envelope)
        return nothing
    end
    if _send_override[] !== nothing
        _send_override[](envelope)
        return nothing
    end
    _comm[] === nothing && error(
        "No PDV comm channel is open. Was bootstrap() called before send_message()?")
    IJulia.CommManager.send_comm(_comm[], envelope)
    nothing
end

"""
    send_error(msg_type, code, message; in_reply_to=nothing)

Send a PDV error response (`status="error"`, payload `{code, message}` —
ARCHITECTURE.md §3.5).
"""
function send_error(msg_type::AbstractString, code::AbstractString,
                    message::AbstractString;
                    in_reply_to::Union{Nothing,AbstractString}=nothing)
    send_message(msg_type,
                 Dict{String,Any}("code" => String(code), "message" => String(message));
                 status="error", in_reply_to=in_reply_to)
end

"""
    check_version(msg::AbstractDict)

Validate the `pdv_version` field of an incoming message. A major-version
mismatch throws `PDVVersionError`; a minor/patch mismatch logs a warning
(ARCHITECTURE.md §3.6).
"""
function check_version(msg::AbstractDict)
    incoming = string(get(msg, "pdv_version", ""))
    expected_core = _core_version(__pdv_protocol_version__)
    incoming_core = _core_version(incoming)
    expected_major = first(split(expected_core, "."))
    incoming_major = isempty(incoming_core) ? "" : first(split(incoming_core, "."))
    if incoming_major != expected_major
        throw(PDVVersionError(
            "Incompatible PDV version: got '$incoming', expected major version " *
            "'$expected_major'"))
    end
    if incoming_core != expected_core
        println(Base.stderr,
                "[PDV] version mismatch: kernel=$(__pdv_protocol_version__), app=$incoming")
        flush(Base.stderr)
    end
    nothing
end

# Extract the PDV envelope from whatever the comm layer hands us: an
# IJulia.Msg (envelope at msg.content["data"]) or a plain Dict (tests).
function _extract_envelope(msg)
    if msg isa AbstractDict
        content = get(msg, "content", nothing)
        if content isa AbstractDict && haskey(content, "data")
            return content["data"]
        end
        return msg
    end
    content = try
        getproperty(msg, :content)
    catch
        nothing
    end
    if content isa AbstractDict && haskey(content, "data")
        return content["data"]
    end
    return msg
end

"""
    on_comm_message(msg)

Handle an incoming comm message from the app: parse the envelope, validate
the version, and dispatch to the registered handler. This function is
installed as the comm's `on_msg` callback by the bootstrap snippet.
"""
function on_comm_message(msg)
    data = _extract_envelope(msg)
    if !(data isa AbstractDict)
        @warn "PDV comm message with non-dict payload dropped" typeof(data)
        return nothing
    end
    try
        check_version(data)
    catch err
        err isa PDVVersionError || rethrow()
        @warn error_message(err)
        return nothing
    end
    # invokelatest: this callback runs inside IJulia's comm handler, whose
    # world age is frozen when the callback is installed (at bootstrap).
    # Without it, methods defined by packages the user loads *later* (e.g.
    # `size(::DataFrame)` once DataFrames is imported) raise "method too new"
    # MethodErrors inside handlers.
    Base.invokelatest(dispatch_message, data)
    nothing
end
