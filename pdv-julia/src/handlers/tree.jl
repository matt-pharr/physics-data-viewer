# PDVKernel handlers — tree query messages.
#
# Handles:
# - pdv.tree.list: return children of a tree node.
# - pdv.tree.get: return value or metadata of a node.
# - pdv.tree.resolve_file: return absolute path for file-backed nodes.

function handle_tree_list(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    path = get(get(msg, "payload", Dict()), "path", "")
    tree = get_pdv_tree()

    if tree === nothing
        send_error("pdv.tree.list.response", "tree.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    # Get the container at the given path
    if !isempty(path)
        if !haskey(tree, path)
            send_error("pdv.tree.list.response", "tree.path_not_found",
                       "No node at path: '$path'"; in_reply_to=msg_id)
            return
        end
        container = try
            tree[path]
        catch
            send_error("pdv.tree.list.response", "tree.path_not_found",
                       "No node at path: '$path'"; in_reply_to=msg_id)
            return
        end
        if !(container isa AbstractDict)
            send_error("pdv.tree.list.response", "tree.not_a_folder",
                       "Node at '$path' is not a folder"; in_reply_to=msg_id)
            return
        end
    else
        container = tree
    end

    nodes = Dict{String,Any}[]

    for (key, value) in container
        child_path = isempty(path) ? key : "$path.$key"
        kind = detect_kind(value)
        preview = node_preview(value, kind)
        has_children = value isa AbstractDict && !isempty(value)
        lazy = has_lazy_entry(tree, child_path)
        descriptor = Dict{String,Any}(
            "id" => child_path,
            "path" => child_path,
            "key" => key,
            "parent_path" => path,
            "type" => kind,
            "has_children" => has_children,
            "lazy" => lazy,
            "preview" => preview,
            "julia_type" => julia_type_string(value),
            "has_handler" => has_handler_for(value),
        )
        if kind == "script"
            descriptor["params"] = [script_param_to_dict(p) for p in params(value)]
        end
        if kind == "module" && value isa PDVModule
            descriptor["module_id"] = module_id(value)
            descriptor["module_name"] = module_name(value)
            descriptor["module_version"] = module_version(value)
        end
        if kind == "gui" && value isa PDVGui
            descriptor["module_id"] = module_id(value)
        end
        if kind == "hdf5" && value isa PDVHDF5
            descriptor["hdf5_path"] = hdf5_path(value)
        end
        push!(nodes, descriptor)
    end

    # Include lazy-only entries at this path level not yet in memory
    for (reg_path, storage) in iter_lazy_entries(tree)
        parts = split(reg_path, ".")
        parent = join(parts[1:end-1], ".")
        if parent == path
            key = String(parts[end])
            if !haskey(container, key)
                push!(nodes, Dict{String,Any}(
                    "id" => reg_path,
                    "path" => reg_path,
                    "key" => key,
                    "parent_path" => path,
                    "type" => get(storage, "format", "unknown"),
                    "has_children" => false,
                    "lazy" => true,
                    "preview" => "<lazy>",
                    "has_handler" => false,
                ))
            end
        end
    end

    send_message("pdv.tree.list.response", Dict{String,Any}("nodes" => nodes);
                 in_reply_to=msg_id)
end

function handle_tree_get(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    path = get(payload, "path", "")
    mode = get(payload, "mode", "value")

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.tree.get.response", "tree.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    if isempty(path)
        send_error("pdv.tree.get.response", "tree.missing_path",
                   "path is required"; in_reply_to=msg_id)
        return
    end

    if !haskey(tree, path)
        send_error("pdv.tree.get.response", "tree.path_not_found",
                   "No node at path: '$path'"; in_reply_to=msg_id)
        return
    end

    if mode == "metadata"
        lazy = has_lazy_entry(tree, path)
        storage = lazy ? lazy_storage_for(tree, path) : Dict()
        if storage === nothing
            storage = Dict()
        end
        send_message("pdv.tree.get.response",
                     Dict{String,Any}("path" => path, "lazy" => lazy,
                                      "type" => get(storage, "format", "unknown"),
                                      "storage" => storage);
                     in_reply_to=msg_id)
        return
    end

    # mode == "value" or "preview"
    value = try
        tree[path]
    catch e
        send_error("pdv.tree.get.response", "tree.load_error",
                   string(e); in_reply_to=msg_id)
        return
    end

    kind = detect_kind(value)
    preview = node_preview(value, kind)
    send_message("pdv.tree.get.response",
                 Dict{String,Any}(
                     "path" => path,
                     "type" => kind,
                     "preview" => preview,
                     "value" => repr(value),
                     "julia_type" => julia_type_string(value),
                     "has_handler" => has_handler_for(value),
                 );
                 in_reply_to=msg_id)
end

function handle_tree_resolve_file(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    path = get(payload, "path", "")

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.tree.resolve_file.response", "tree.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    if isempty(path) || !haskey(tree, path)
        send_error("pdv.tree.resolve_file.response", "tree.path_not_found",
                   "No node at path: '$path'"; in_reply_to=msg_id)
        return
    end

    node = tree[path]
    if !(node isa PDVFile)
        send_error("pdv.tree.resolve_file.response", "tree.not_a_file",
                   "Node at '$path' is not file-backed"; in_reply_to=msg_id)
        return
    end

    wd = get_tree_working_dir(tree)
    abs_path = resolve_file_path(node, wd)
    if !isabspath(abs_path)
        abs_path = joinpath(wd, abs_path)
    end

    send_message("pdv.tree.resolve_file.response",
                 Dict{String,Any}("path" => path, "file_path" => abs_path);
                 in_reply_to=msg_id)
end
