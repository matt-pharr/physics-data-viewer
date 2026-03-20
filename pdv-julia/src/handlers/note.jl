# PDVKernel handlers — note registration messages.
#
# Handles:
# - pdv.note.register: attach a PDVNote node to the tree.

function handle_note_register(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    parent_path = get(payload, "parent_path", "")
    name = get(payload, "name", "")
    rel_path = get(payload, "relative_path", "")

    if isempty(name)
        send_error("pdv.note.register.response", "note.missing_name",
                   "name is required in pdv.note.register payload";
                   in_reply_to=msg_id)
        return
    end
    if isempty(rel_path)
        send_error("pdv.note.register.response", "note.missing_relative_path",
                   "relative_path is required in pdv.note.register payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.note.register.response", "note.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    note = PDVNote(rel_path)
    full_path = isempty(parent_path) ? name : "$parent_path.$name"
    tree[full_path] = note

    send_message("pdv.note.register.response",
                 Dict{String,Any}("path" => full_path); in_reply_to=msg_id)
end
