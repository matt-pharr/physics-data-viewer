# PDVKernel handlers — script registration messages.
#
# Handles:
# - pdv.script.register: attach a PDVScript node to the tree.

function handle_script_register(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    parent_path = get(payload, "parent_path", "")
    name = get(payload, "name", "")
    rel_path = get(payload, "relative_path", "")
    lang = get(payload, "language", "julia")

    if isempty(name)
        send_error("pdv.script.register.response", "script.missing_name",
                   "name is required in pdv.script.register payload";
                   in_reply_to=msg_id)
        return
    end
    if isempty(rel_path)
        send_error("pdv.script.register.response", "script.missing_relative_path",
                   "relative_path is required in pdv.script.register payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.script.register.response", "script.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    script = PDVScript(rel_path; language=lang)
    full_path = isempty(parent_path) ? name : "$parent_path.$name"
    tree[full_path] = script

    send_message("pdv.script.register.response",
                 Dict{String,Any}("path" => full_path); in_reply_to=msg_id)
end
