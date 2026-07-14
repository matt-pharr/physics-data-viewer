# handlers/script.jl — pdv.script.register and pdv.script.params handlers.
#
# Port of pdv/handlers/script.py.

"""
    handle_script_register(msg)

Handle `pdv.script.register`: create a `PDVScript` and attach it at
`parent_path.name` (the mutation itself emits the tree-changed push).
"""
function handle_script_register(msg::AbstractDict)
    validated = validate_register_request(msg, "pdv.script.register.response", "script")
    validated === nothing && return nothing
    tree, payload = validated
    parent_path = string(get(payload, "parent_path", ""))
    name = string(get(payload, "name", ""))
    node_uuid = string(get(payload, "uuid", ""))
    filename = string(get(payload, "filename", ""))
    language = string(get(payload, "language", "julia"))
    src_rel_raw = get(payload, "source_rel_path", nothing)
    module_id = string(get(payload, "module_id", ""))

    script = PDVScript(uuid=node_uuid, filename=filename, language=language,
                       module_id=module_id,
                       source_rel_path=src_rel_raw === nothing ? nothing : string(src_rel_raw))
    full_path = isempty(parent_path) ? name : "$parent_path.$name"
    tree[full_path] = script

    send_message("pdv.script.register.response", Dict{String,Any}("path" => full_path);
                 in_reply_to=get(msg, "msg_id", nothing))
    nothing
end

"""
    handle_script_params(msg)

Handle `pdv.script.params`: extract the current `run()` keyword parameters
from a script file on disk (always read fresh so edits are reflected).
"""
function handle_script_params(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.script.params.response", "script";
                                          required_fields=("path",))
    validated === nothing && return nothing
    tree, payload = validated
    tree_path = string(get(payload, "path", ""))

    node = try
        tree[tree_path]
    catch e
        e isa PDVKeyError || rethrow()
        send_error("pdv.script.params.response", "script.not_found",
                   "No node at path: $tree_path"; in_reply_to=msg_id)
        return nothing
    end
    if !(node isa PDVScript)
        send_error("pdv.script.params.response", "script.not_a_script",
                   "Node at $tree_path is not a PDVScript"; in_reply_to=msg_id)
        return nothing
    end

    resolved = resolve_path(node, tree.working_dir)
    params = extract_script_params(resolved)
    send_message("pdv.script.params.response", Dict{String,Any}("params" => params);
                 in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.script.register", handle_script_register)
register_message_handler("pdv.script.params", handle_script_params)
