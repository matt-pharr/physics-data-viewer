# handlers/tree.jl — Handlers for PDV tree query and mutation messages.
#
# Port of pdv/handlers/tree.py: pdv.tree.list / get / resolve_file / delete /
# create_node / rename / move / duplicate.

# Duplicate backing files for all PDVFile nodes in `value`. With UUID-based
# storage, rename/move is a metadata-only operation; only duplication
# (copy=true) creates new files with fresh UUIDs.
function _relocate_files(value, working_dir::String; copy::Bool=false)
    if value isa AbstractPDVFile
        copy || return nothing
        old_abs = resolve_path(value, working_dir)
        new_uuid = generate_node_uuid()
        new_abs = uuid_tree_path(working_dir, new_uuid, value.filename)
        isfile(old_abs) && smart_copy(old_abs, new_abs)
        value.uuid = new_uuid
    elseif value isa AbstractPDVTree
        for key in collect(keys(value.data))
            _relocate_files(value.data[key], working_dir; copy=copy)
        end
    elseif value isa AbstractDict
        for key in collect(keys(value))
            _relocate_files(value[key], working_dir; copy=copy)
        end
    end
    nothing
end

"""
    handle_tree_list(msg)

Handle `pdv.tree.list`: return the children of the node at `path` as node
descriptor Dicts. Dict children carry their own keys; NamedTuple children
their field names; vector/tuple children get stringified 1-based indices.
NamedTuple and vector/tuple children carry a `parent_is_opaque` flag so the
renderer suppresses structural mutations on them (their parents are not
key-addressable stores — NamedTuples are immutable).
"""
function handle_tree_list(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.list.response", "tree";
                                          required_fields=())
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))

    local container
    if !isempty(path)
        container = try
            tree[path]
        catch
            send_error("pdv.tree.list.response", "tree.path_not_found",
                       "No node at path: '$path'"; in_reply_to=msg_id)
            return nothing
        end
        if !(container isa Union{AbstractPDVTree,AbstractDict,NamedTuple,AbstractVector,Tuple})
            send_error("pdv.tree.list.response", "tree.not_a_folder",
                       "Node at '$path' is not a folder"; in_reply_to=msg_id)
            return nothing
        end
    else
        container = tree
    end

    nodes, _ = _list_container_nodes(container, path)
    send_message("pdv.tree.list.response", Dict{String,Any}("nodes" => nodes);
                 in_reply_to=msg_id)
    nothing
end

"""
    _list_container_nodes(container, path) -> (nodes, expandable)

Build the child node descriptors for a container — the shared core of
`handle_tree_list` and the query-cache rebuild. `expandable` pairs each
`has_children` child's path with its value so a cache walk can recurse
without re-resolving dot paths.
"""
function _list_container_nodes(container, path::String)
    parent_is_opaque =
        container isa AbstractVector || container isa Tuple || container isa NamedTuple
    keys_iter = if container isa AbstractPDVTree
        collect(keys(container.data))
    elseif container isa AbstractDict || container isa NamedTuple
        [string(k) for k in keys(container)]
    else
        [string(i) for i in 1:length(container)]
    end

    nodes = Dict{String,Any}[]
    expandable = Tuple{String,Any}[]
    for key in keys_iter
        local value
        if container isa AbstractPDVTree
            haskey(container.data, key) || continue  # deleted concurrently
            value = container.data[key]
        elseif container isa NamedTuple
            value = container[Symbol(key)]
        elseif container isa AbstractDict
            if haskey(container, key)
                value = container[key]
            elseif haskey(container, Symbol(key))
                value = container[Symbol(key)]
            else
                continue
            end
        else
            value = container[parse(Int, key)]
        end
        child_path = isempty(path) ? key : "$path.$key"
        kind = detect_kind(value)
        preview_str = node_preview(value, kind)
        has_children = if value isa Union{AbstractPDVTree,AbstractDict,NamedTuple}
            !isempty(value)
        elseif kind == KIND_SEQUENCE && value isa Union{AbstractVector,Tuple}
            !isempty(value)
        else
            false
        end
        descriptor = Dict{String,Any}(
            "id" => child_path,
            "path" => child_path,
            "key" => key,
            "parent_path" => path,
            "type" => kind,
            "has_children" => has_children,
            "preview" => preview_str,
            "python_type" => julia_type_string(value),
            "has_handler" => has_handler_for(value),
        )
        parent_is_opaque && (descriptor["parent_is_opaque"] = true)
        if kind == KIND_MODULE && value isa PDVModule
            descriptor["module_id"] = value.module_id
            descriptor["module_name"] = value.name
            descriptor["module_version"] = value.version
            isempty(value.description) || (descriptor["module_description"] = value.description)
            isempty(value.language) || (descriptor["module_language"] = value.language)
        end
        if kind == KIND_GUI && value isa PDVGui
            descriptor["module_id"] = value.module_id
        end
        push!(nodes, descriptor)
        has_children && push!(expandable, (child_path, value))
    end
    return nodes, expandable
end

# Character cap for the repr sent by pdv.tree.get's value mode.
const _VALUE_REPR_CAP = 10_000

"""
    handle_tree_get(msg)

Handle `pdv.tree.get`: descriptive metadata for one node; value mode adds a
size-capped `repr`.
"""
function handle_tree_get(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.get.response", "tree";
                                          required_fields=("path",))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))
    mode = string(get(payload, "mode", "value"))

    if !haskey(tree, path)
        send_error("pdv.tree.get.response", "tree.path_not_found",
                   "No node at path: '$path'"; in_reply_to=msg_id)
        return nothing
    end
    value = try
        tree[path]
    catch err
        send_error("pdv.tree.get.response", "tree.load_error",
                   sprint(showerror, err); in_reply_to=msg_id)
        return nothing
    end

    kind = detect_kind(value)
    result = Dict{String,Any}(
        "path" => path,
        "type" => kind,
        "preview" => node_preview(value, kind),
        "python_type" => julia_type_string(value),
        "has_handler" => has_handler_for(value),
    )
    if !(mode in ("metadata", "preview"))
        raw = if value isa AbstractString && length(value) > _VALUE_REPR_CAP
            repr(first(value, _VALUE_REPR_CAP))
        else
            sprint(show, MIME"text/plain"(), value; context=(:limit => true))
        end
        if length(raw) > _VALUE_REPR_CAP ||
           (value isa AbstractString && length(value) > _VALUE_REPR_CAP)
            result["value"] = first(raw, _VALUE_REPR_CAP) * "… (truncated)"
            result["value_truncated"] = true
        else
            result["value"] = raw
        end
    end
    send_message("pdv.tree.get.response", result; in_reply_to=msg_id)
    nothing
end

"""
    handle_tree_resolve_file(msg)

Handle `pdv.tree.resolve_file`: absolute file path for a file-backed node.
"""
function handle_tree_resolve_file(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.resolve_file.response", "tree";
                                          required_fields=("path",))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))

    if !haskey(tree, path)
        send_error("pdv.tree.resolve_file.response", "tree.path_not_found",
                   "No node at path: '$path'"; in_reply_to=msg_id)
        return nothing
    end
    node = tree[path]
    if !(node isa AbstractPDVFile)
        send_error("pdv.tree.resolve_file.response", "tree.not_a_file",
                   "Node at '$path' is not file-backed"; in_reply_to=msg_id)
        return nothing
    end

    abs_path = resolve_path(node, tree.working_dir)
    send_message("pdv.tree.resolve_file.response",
                 Dict{String,Any}("path" => path, "file_path" => abs_path);
                 in_reply_to=msg_id)
    nothing
end

"""Handle `pdv.tree.delete` — remove a node from the tree by path."""
function handle_tree_delete(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.delete.response", "tree";
                                          required_fields=("path",))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))

    try
        delete!(tree, path)
    catch e
        e isa PDVKeyError || rethrow()
        send_error("pdv.tree.delete.response", "tree.path_not_found",
                   "No node exists at path: $path"; in_reply_to=msg_id)
        return nothing
    end

    send_message("pdv.tree.delete.response",
                 Dict{String,Any}("path" => path, "deleted" => true); in_reply_to=msg_id)
    nothing
end

"""Handle `pdv.tree.create_node` — create an empty container node."""
function handle_tree_create_node(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.create_node.response", "tree";
                                          required_fields=("name",))
    validated === nothing && return nothing
    tree, payload = validated
    parent_path = string(get(payload, "parent_path", ""))
    name = string(get(payload, "name", ""))

    if occursin(".", name)
        send_error("pdv.tree.create_node.response", "tree.invalid_name",
                   "Node name must not contain '.': $(repr(name))"; in_reply_to=msg_id)
        return nothing
    end

    full_path = isempty(parent_path) ? name : "$parent_path.$name"

    if haskey(tree, full_path)
        send_error("pdv.tree.create_node.response", "tree.already_exists",
                   "A node already exists at path: $full_path"; in_reply_to=msg_id)
        return nothing
    end
    if !isempty(parent_path)
        if !haskey(tree, parent_path)
            send_error("pdv.tree.create_node.response", "tree.path_not_found",
                       "Parent path does not exist: $parent_path"; in_reply_to=msg_id)
            return nothing
        end
        parent = tree[parent_path]
        if !(parent isa Union{AbstractPDVTree,AbstractDict})
            send_error("pdv.tree.create_node.response", "tree.not_a_container",
                       "Parent at '$parent_path' is not a container."; in_reply_to=msg_id)
            return nothing
        end
    end

    tree[full_path] = PDVTree()
    send_message("pdv.tree.create_node.response",
                 Dict{String,Any}("path" => full_path, "created" => true);
                 in_reply_to=msg_id)
    nothing
end

# Remove the raw dict entry at `path` without emitting a notification —
# shared by rename/move which emit their own removed+added pair.
function _raw_remove!(tree::AbstractPDVTree, path::String)
    parts = split_dot_path(path)
    if length(parts) == 1
        delete!(tree.data, parts[1])
    else
        parent = _resolve_nested(tree, parts[1:end-1])
        _child_delete!(parent, parts[end])
    end
    nothing
end

"""Handle `pdv.tree.rename` — re-key a node under the same parent."""
function handle_tree_rename(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.rename.response", "tree";
                                          required_fields=("path", "new_name"))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))
    new_name = string(get(payload, "new_name", ""))

    if occursin(".", new_name)
        send_error("pdv.tree.rename.response", "tree.invalid_name",
                   "New name must not contain dots."; in_reply_to=msg_id)
        return nothing
    end
    if !haskey(tree, path)
        send_error("pdv.tree.rename.response", "tree.path_not_found",
                   "No node at path: $path"; in_reply_to=msg_id)
        return nothing
    end

    parts = split(path, ".")
    parent_path = join(parts[1:end-1], ".")
    new_path = isempty(parent_path) ? new_name : "$parent_path.$new_name"

    if haskey(tree, new_path)
        send_error("pdv.tree.rename.response", "tree.already_exists",
                   "A node already exists at path: $new_path"; in_reply_to=msg_id)
        return nothing
    end

    value = tree[path]
    set_quiet!(tree, new_path, value)
    _raw_remove!(tree, path)
    # A rename is a removal + an addition; the debounced flush batches them.
    _emit_changed(tree, path, "removed")
    _emit_changed(tree, new_path, "added")

    send_message("pdv.tree.rename.response", Dict{String,Any}(
        "old_path" => path, "new_path" => new_path, "renamed" => true);
        in_reply_to=msg_id)
    nothing
end

"""Handle `pdv.tree.move` — re-parent a node."""
function handle_tree_move(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.move.response", "tree";
                                          required_fields=("path", "new_path"))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))
    new_path = string(get(payload, "new_path", ""))

    if path == new_path
        send_error("pdv.tree.move.response", "tree.same_path",
                   "Source and destination are the same."; in_reply_to=msg_id)
        return nothing
    end
    if !haskey(tree, path)
        send_error("pdv.tree.move.response", "tree.path_not_found",
                   "No node at path: $path"; in_reply_to=msg_id)
        return nothing
    end
    if haskey(tree, new_path)
        send_error("pdv.tree.move.response", "tree.already_exists",
                   "A node already exists at path: $new_path"; in_reply_to=msg_id)
        return nothing
    end
    if startswith(new_path, path * ".")
        send_error("pdv.tree.move.response", "tree.circular_move",
                   "Cannot move '$path' into its own subtree."; in_reply_to=msg_id)
        return nothing
    end

    new_parts = split(new_path, ".")
    if length(new_parts) > 1
        dest_parent = join(new_parts[1:end-1], ".")
        if !haskey(tree, dest_parent)
            send_error("pdv.tree.move.response", "tree.path_not_found",
                       "Destination parent does not exist: $dest_parent";
                       in_reply_to=msg_id)
            return nothing
        end
        parent_val = tree[dest_parent]
        if !(parent_val isa Union{AbstractPDVTree,AbstractDict})
            send_error("pdv.tree.move.response", "tree.not_a_container",
                       "Destination parent '$dest_parent' is not a container.";
                       in_reply_to=msg_id)
            return nothing
        end
    end

    value = tree[path]
    set_quiet!(tree, new_path, value)
    _raw_remove!(tree, path)
    _emit_changed(tree, path, "removed")
    _emit_changed(tree, new_path, "added")

    send_message("pdv.tree.move.response", Dict{String,Any}(
        "old_path" => path, "new_path" => new_path, "moved" => true);
        in_reply_to=msg_id)
    nothing
end

"""Handle `pdv.tree.duplicate` — deep-copy a node to a new path."""
function handle_tree_duplicate(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.duplicate.response", "tree";
                                          required_fields=("path", "new_path"))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))
    new_path = string(get(payload, "new_path", ""))

    if !haskey(tree, path)
        send_error("pdv.tree.duplicate.response", "tree.path_not_found",
                   "No node at path: $path"; in_reply_to=msg_id)
        return nothing
    end
    if haskey(tree, new_path)
        send_error("pdv.tree.duplicate.response", "tree.already_exists",
                   "A node already exists at path: $new_path"; in_reply_to=msg_id)
        return nothing
    end
    new_parts = split(new_path, ".")
    if length(new_parts) > 1
        dest_parent = join(new_parts[1:end-1], ".")
        if !haskey(tree, dest_parent)
            send_error("pdv.tree.duplicate.response", "tree.path_not_found",
                       "Destination parent does not exist: $dest_parent";
                       in_reply_to=msg_id)
            return nothing
        end
        parent_val = tree[dest_parent]
        if !(parent_val isa Union{AbstractPDVTree,AbstractDict})
            send_error("pdv.tree.duplicate.response", "tree.not_a_container",
                       "Destination parent '$dest_parent' is not a container.";
                       in_reply_to=msg_id)
            return nothing
        end
    end

    value = tree[path]
    cloned = deepcopy(value)
    tree.working_dir !== nothing && _relocate_files(cloned, tree.working_dir; copy=true)
    tree[new_path] = cloned

    send_message("pdv.tree.duplicate.response", Dict{String,Any}(
        "source_path" => path, "new_path" => new_path, "duplicated" => true);
        in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.tree.list", handle_tree_list)
register_message_handler("pdv.tree.get", handle_tree_get)
register_message_handler("pdv.tree.resolve_file", handle_tree_resolve_file)
register_message_handler("pdv.tree.delete", handle_tree_delete)
register_message_handler("pdv.tree.create_node", handle_tree_create_node)
register_message_handler("pdv.tree.rename", handle_tree_rename)
register_message_handler("pdv.tree.move", handle_tree_move)
register_message_handler("pdv.tree.duplicate", handle_tree_duplicate)
