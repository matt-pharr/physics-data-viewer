# PDVKernel handlers — project messages.
#
# Handles:
# - pdv.project.load: load a project from a save directory.
# - pdv.project.save: serialize the current tree to a save directory.

function _set_tree_node_silent!(tree::PDVTree, path::String, value)
    parts = split(path, ".")
    current = tree
    for part in parts[1:end-1]
        if !haskey(current._data, String(part))
            new_node = PDVTree()
            new_node._lazy_registry = tree._lazy_registry
            current._data[String(part)] = new_node
        end
        current = current._data[String(part)]
    end
    current._data[String(parts[end])] = value
end

function _collect_nodes(tree::PDVTree, save_dir::String;
                        prefix::String="", working_dir::String="")::Vector{Dict{String,Any}}
    nodes = Dict{String,Any}[]
    for (key, value) in tree._data
        path = isempty(prefix) ? key : "$prefix.$key"
        descriptor = serialize_node(
            path, value, save_dir;
            trusted=true,
            source_dir=isempty(working_dir) ? save_dir : working_dir,
        )
        push!(nodes, descriptor)
        if value isa PDVTree
            append!(nodes, _collect_nodes(value, save_dir; prefix=path, working_dir=working_dir))
        elseif value isa PDVModule
            append!(nodes, _collect_nodes(children_tree(value), save_dir;
                                          prefix=path, working_dir=working_dir))
        end
    end
    return nodes
end

function handle_project_load(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    save_dir = get(payload, "save_dir", "")

    if isempty(save_dir) || !isdir(save_dir)
        send_error("pdv.project.load.response", "project.invalid_save_dir",
                   "save_dir does not exist or is not a directory: '$save_dir'";
                   in_reply_to=msg_id)
        return
    end

    tree_index_path = joinpath(save_dir, "tree-index.json")
    if !isfile(tree_index_path)
        send_error("pdv.project.load.response", "project.missing_tree_index",
                   "tree-index.json not found in save directory: '$save_dir'";
                   in_reply_to=msg_id)
        return
    end

    nodes = try
        JSON.parsefile(tree_index_path)
    catch e
        send_error("pdv.project.load.response", "project.corrupt_tree_index",
                   "Failed to parse tree-index.json: $e"; in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.project.load.response", "project.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    # Clear existing tree
    empty!(tree._data)
    clear_registry!(tree._lazy_registry)
    set_save_dir!(tree, save_dir)

    working_dir = something(tree._working_dir, save_dir)

    # Pass 1: Containers (folder, module)
    for node in nodes
        node_path = get(node, "path", "")
        node_type = get(node, "type", "")
        meta = get(node, "metadata", Dict())

        if node_type == "folder"
            folder = PDVTree()
            folder._lazy_registry = tree._lazy_registry
            folder._working_dir = tree._working_dir
            folder._save_dir = tree._save_dir
            folder._path_prefix = node_path
            _set_tree_node_silent!(tree, node_path, folder)
        elseif node_type == "module"
            storage = get(node, "storage", Dict())
            old_meta = get(storage, "value", Dict())
            mod = PDVModule(
                get(meta, "module_id", get(old_meta, "module_id", "")),
                get(meta, "name", get(old_meta, "name", "")),
                get(meta, "version", get(old_meta, "version", "")),
            )
            ct = children_tree(mod)
            ct._lazy_registry = tree._lazy_registry
            ct._working_dir = tree._working_dir
            ct._save_dir = tree._save_dir
            ct._path_prefix = node_path
            _set_tree_node_silent!(tree, node_path, mod)
        end
    end

    # Pass 2: Leaves
    for node in nodes
        node_path = get(node, "path", "")
        node_type = get(node, "type", "")
        storage = get(node, "storage", Dict())
        backend = get(storage, "backend", "")
        meta = get(node, "metadata", Dict())

        if node_type in ("folder", "module")
            continue
        end

        rel_path = get(storage, "relative_path", "")

        if node_type == "script"
            lang = get(meta, "language", get(node, "language", "julia"))
            doc_str = get(meta, "doc", nothing)
            _set_tree_node_silent!(tree, node_path,
                PDVScript(rel_path; language=lang, doc=doc_str))
        elseif node_type == "markdown"
            title_str = get(meta, "title", nothing)
            _set_tree_node_silent!(tree, node_path,
                PDVNote(rel_path; title=title_str))
        elseif node_type == "gui"
            mid = get(meta, "module_id", get(node, "module_id", nothing))
            gui_node = PDVGui(rel_path; module_id=mid)
            _set_tree_node_silent!(tree, node_path, gui_node)
            # Attach gui to parent module if applicable
            parts = split(node_path, ".")
            if length(parts) > 1
                parent_path = join(parts[1:end-1], ".")
                try
                    parent = tree[parent_path]
                    if parent isa PDVModule
                        set_gui!(parent, gui_node)
                    end
                catch
                end
            end
        elseif node_type == "namelist"
            mid = get(meta, "module_id", get(node, "module_id", nothing))
            nml_fmt = get(meta, "namelist_format", get(node, "namelist_format", "auto"))
            _set_tree_node_silent!(tree, node_path,
                PDVNamelist(rel_path; format=nml_fmt, module_id=mid))
        elseif node_type == "lib"
            mid = get(meta, "module_id", get(node, "module_id", nothing))
            _set_tree_node_silent!(tree, node_path,
                PDVLib(rel_path; module_id=mid))
            # Add parent directory to LOAD_PATH
            abs_path = isempty(rel_path) ? "" : joinpath(working_dir, rel_path)
            if !isempty(abs_path)
                parent_dir = dirname(abs_path)
                if !isempty(parent_dir) && !(parent_dir in LOAD_PATH)
                    pushfirst!(LOAD_PATH, parent_dir)
                end
            end
        elseif node_type == "hdf5"
            hp = get(meta, "hdf5_path", "/")
            _set_tree_node_silent!(tree, node_path,
                PDVHDF5(rel_path; hdf5_path=hp))
        elseif backend == "inline"
            _set_tree_node_silent!(tree, node_path, get(storage, "value", nothing))
        elseif get(node, "lazy", false)
            register!(tree._lazy_registry, node_path, storage)
        else
            register!(tree._lazy_registry, node_path, storage)
        end
    end

    node_count = length(nodes)
    send_message("pdv.project.load.response",
                 Dict{String,Any}("node_count" => node_count); in_reply_to=msg_id)
    send_message("pdv.project.loaded",
                 Dict{String,Any}("node_count" => node_count,
                                  "project_name" => "", "saved_at" => ""))
end

function handle_project_save(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    save_dir = get(payload, "save_dir", "")

    if isempty(save_dir)
        send_error("pdv.project.save.response", "project.missing_save_dir",
                   "save_dir is required in the pdv.project.save payload";
                   in_reply_to=msg_id)
        return
    end

    mkpath(joinpath(save_dir, "tree"))

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.project.save.response", "project.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    wd = something(tree._working_dir, save_dir)

    nodes = try
        _collect_nodes(tree, save_dir; working_dir=wd)
    catch e
        send_error("pdv.project.save.response", "project.serialization_error",
                   string(e); in_reply_to=msg_id)
        return
    end

    index_data = JSON.json(nodes, 2)
    index_path = joinpath(save_dir, "tree-index.json")
    Base.write(index_path, index_data)

    checksum = bytes2hex(SHA.sha256(Vector{UInt8}(index_data)))

    send_message("pdv.project.save.response",
                 Dict{String,Any}("node_count" => length(nodes), "checksum" => checksum);
                 in_reply_to=msg_id)
end
