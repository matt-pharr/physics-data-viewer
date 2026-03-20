# PDVKernel comms — PDV comm channel registration, message dispatch, and sending.
#
# This module is the kernel-side comm layer. It:
# 1. Registers the `pdv.kernel` comm target with IJulia on bootstrap.
# 2. Receives incoming comm messages and dispatches to handlers.
# 3. Provides send_message() for building and sending PDV messages.

const PDV_PROTOCOL_VERSION = "1.0"
const PDV_COMM_TARGET = "pdv.kernel"

# Global state (set on bootstrap, nothing before that)
const _comm = Ref{Any}(nothing)
const _bootstrapped = Ref{Bool}(false)
const _pdv_tree = Ref{Any}(nothing)

"""
    send_message(msg_type, payload; status="ok", in_reply_to=nothing)

Send a PDV message from the kernel to the app.
Constructs the standard PDV envelope and sends it on the open comm channel.
"""
function send_message(msg_type::String, payload::Dict;
                      status::String="ok",
                      in_reply_to::Union{String,Nothing}=nothing)
    if _comm[] === nothing
        throw(ErrorException(
            "No PDV comm channel is open. Was bootstrap() called before send_message()?"
        ))
    end
    envelope = Dict{String,Any}(
        "pdv_version" => PDV_PROTOCOL_VERSION,
        "msg_id" => string(uuid4()),
        "in_reply_to" => in_reply_to,
        "type" => msg_type,
        "status" => status,
        "payload" => payload,
    )
    _send_comm_data(envelope)
end

"""
    send_error(msg_type, code, message; in_reply_to=nothing)

Send a PDV error response.
"""
function send_error(msg_type::String, code::String, message::String;
                    in_reply_to::Union{String,Nothing}=nothing)
    send_message(
        msg_type,
        Dict{String,Any}("code" => code, "message" => message);
        status="error",
        in_reply_to=in_reply_to,
    )
end

"""
    check_version(msg::Dict)

Validate the pdv_version field of an incoming message.
"""
function check_version(msg::Dict)
    incoming = string(get(msg, "pdv_version", ""))
    expected_major = first(split(PDV_PROTOCOL_VERSION, "."))
    incoming_major = isempty(incoming) ? "" : first(split(incoming, "."))
    if incoming_major != expected_major
        throw(PDVVersionError(
            "Incompatible PDV protocol version: got '$incoming', " *
            "expected major version '$expected_major'"
        ))
    end
end

"""
    on_comm_message(msg)

Handle an incoming comm message from the app.
Accepts both a raw Dict and an IJulia.Msg object (which has a `.content` field).
"""
function on_comm_message(msg)
    # Extract the PDV envelope from the message.
    # IJulia passes an IJulia.Msg object whose .content["data"] holds our payload.
    # Direct Dict callers (e.g. tests) may pass the envelope directly.
    local data::Dict
    if msg isa Dict
        data = get(get(msg, "content", Dict()), "data", msg)
    else
        # IJulia.Msg — access .content field
        content = try
            msg.content
        catch
            Dict()
        end
        data = get(content, "data", content isa Dict ? content : Dict())
    end

    try
        check_version(data)
    catch e
        if e isa PDVVersionError
            @warn string(e)
            return
        end
        rethrow()
    end

    dispatch(data)
end

"""
    register_comm_target()

Register the `pdv.kernel` comm target with IJulia.
"""
function register_comm_target()
    ijulia = _get_ijulia()
    if ijulia === nothing
        throw(ErrorException("IJulia is not available; cannot register comm target"))
    end

    # IJulia comm registration: register a handler for comm_open on our target
    ijulia.register_comm(PDV_COMM_TARGET, _on_comm_open_handler)
end

function _on_comm_open_handler(comm, open_msg)
    _comm[] = comm
    # Register message handler on this comm
    comm.on_msg = on_comm_message
    # Send pdv.ready push notification
    send_message("pdv.ready", Dict{String,Any}(); in_reply_to=nothing)
end

"""
    get_pdv_tree()

Return the global PDVTree instance, or nothing if not bootstrapped.
"""
get_pdv_tree() = _pdv_tree[]

# ---------------------------------------------------------------------------
# IJulia comm adapter
# ---------------------------------------------------------------------------

function _send_comm_data(data::Dict)
    comm = _comm[]
    if comm === nothing
        throw(ErrorException("No comm channel is open"))
    end
    # Use IJulia's CommManager.send_comm to send data on the open comm channel.
    ijulia = _get_ijulia()
    if ijulia !== nothing
        ijulia.CommManager.send_comm(comm, data)
    else
        throw(ErrorException("IJulia is not available; cannot send comm data"))
    end
end

function _get_ijulia()
    try
        return Base.require(Main, :IJulia)
    catch
        return nothing
    end
end
