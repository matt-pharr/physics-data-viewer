# PDVKernel handlers — GUI registration messages.
#
# Handles:
# - pdv.gui.register: attach a PDVGui node to the tree.

function handle_gui_register(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    parent_path = get(payload, "parent_path", "")
    name = get(payload, "name", "")
    rel_path = get(payload, "relative_path", "")
    mid = get(payload, "module_id", nothing)

    if isempty(name)
        send_error("pdv.gui.register.response", "gui.missing_name",
                   "name is required in pdv.gui.register payload";
                   in_reply_to=msg_id)
        return
    end
    if isempty(rel_path)
        send_error("pdv.gui.register.response", "gui.missing_relative_path",
                   "relative_path is required in pdv.gui.register payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.gui.register.response", "gui.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    gui_node = PDVGui(rel_path; module_id=mid)
    full_path = isempty(parent_path) ? name : "$parent_path.$name"
    tree[full_path] = gui_node

    # Attach gui to parent module if applicable
    if !isempty(parent_path)
        try
            parent = tree[parent_path]
            if parent isa PDVModule
                set_gui!(parent, gui_node)
            end
        catch
        end
    end

    send_message("pdv.gui.register.response",
                 Dict{String,Any}("path" => full_path); in_reply_to=msg_id)
end
