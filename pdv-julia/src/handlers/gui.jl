# handlers/gui.jl — pdv.gui.register handler.
#
# Port of pdv/handlers/gui.py.

"""
    handle_gui_register(msg)

Handle `pdv.gui.register`: create a `PDVGui`, attach it at
`parent_path.name`, and set the parent module's `gui` reference when the
parent is a `PDVModule`.
"""
function handle_gui_register(msg::AbstractDict)
    validated = validate_register_request(msg, "pdv.gui.register.response", "gui")
    validated === nothing && return nothing
    tree, payload = validated
    parent_path = string(get(payload, "parent_path", ""))
    name = string(get(payload, "name", ""))
    node_uuid = string(get(payload, "uuid", ""))
    filename = string(get(payload, "filename", ""))
    module_id_raw = get(payload, "module_id", nothing)
    src_rel_raw = get(payload, "source_rel_path", nothing)

    gui_node = PDVGui(uuid=node_uuid, filename=filename,
                      module_id=module_id_raw === nothing ? nothing : string(module_id_raw),
                      source_rel_path=src_rel_raw === nothing ? nothing : string(src_rel_raw))
    full_path = isempty(parent_path) ? name : "$parent_path.$name"
    tree[full_path] = gui_node
    attach_gui_to_module(tree, parent_path, gui_node)

    send_message("pdv.gui.register.response", Dict{String,Any}("path" => full_path);
                 in_reply_to=get(msg, "msg_id", nothing))
    nothing
end

register_message_handler("pdv.gui.register", handle_gui_register)
