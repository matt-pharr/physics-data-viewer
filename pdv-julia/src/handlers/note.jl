# handlers/note.jl — pdv.note.register handler.
#
# Port of pdv/handlers/note.py.

"""
    handle_note_register(msg)

Handle `pdv.note.register`: create a `PDVNote` and attach it at
`parent_path.name`.
"""
function handle_note_register(msg::AbstractDict)
    validated = validate_register_request(msg, "pdv.note.register.response", "note")
    validated === nothing && return nothing
    tree, payload = validated
    parent_path = string(get(payload, "parent_path", ""))
    name = string(get(payload, "name", ""))
    node_uuid = string(get(payload, "uuid", ""))
    filename = string(get(payload, "filename", ""))

    note = PDVNote(uuid=node_uuid, filename=filename)
    full_path = isempty(parent_path) ? name : "$parent_path.$name"
    tree[full_path] = note

    send_message("pdv.note.register.response", Dict{String,Any}("path" => full_path);
                 in_reply_to=get(msg, "msg_id", nothing))
    nothing
end

register_message_handler("pdv.note.register", handle_note_register)
