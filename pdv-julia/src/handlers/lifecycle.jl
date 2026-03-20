# PDVKernel handlers — lifecycle messages.
#
# Handles:
# - pdv.init: receives working directory path and initial config from the app.

function handle_init(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    working_dir = get(payload, "working_dir", nothing)

    if working_dir === nothing || isempty(working_dir)
        send_error(
            "pdv.init.response",
            "init.missing_working_dir",
            "working_dir is required in the pdv.init payload";
            in_reply_to=msg_id,
        )
        return
    end

    try
        validated = validate_working_dir(working_dir)
        tree = get_pdv_tree()
        if tree !== nothing
            set_working_dir!(tree, validated)
        end
        send_message("pdv.init.response", Dict{String,Any}(); in_reply_to=msg_id)
    catch e
        if e isa PDVPathError
            send_error(
                "pdv.init.response",
                "init.invalid_working_dir",
                e.msg;
                in_reply_to=msg_id,
            )
        else
            rethrow()
        end
    end
end
