# PDVKernel handlers — module namespace setup and handler invocation.
#
# Handles:
# - pdv.module.register: create a PDVModule in the tree.
# - pdv.modules.setup: add module paths and run entry points.
# - pdv.handler.invoke: dispatch a registered handler for a tree node.

function handle_module_register(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    alias = get(payload, "path", "")
    mid = get(payload, "module_id", "")
    name = get(payload, "name", "")
    version = get(payload, "version", "")
    module_index = get(payload, "module_index", nothing)

    if isempty(alias) || isempty(mid)
        send_error("pdv.module.register.response", "module.missing_fields",
                   "path and module_id are required in pdv.module.register payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.module.register.response", "module.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    # Create the root PDVModule node at the alias path.
    existing = get(tree, alias, nothing)
    if existing isa PDVModule
        existing._module_id = mid
        existing._name = name
        existing._version = version
    elseif existing isa AbstractDict && !isempty(existing)
        module_node = PDVModule(mid, name, version)
        for (k, v) in existing
            module_node[k] = v
        end
        tree[alias] = module_node
    else
        tree[alias] = PDVModule(mid, name, version)
    end

    # v4: mount subtree from module_index (same two-pass logic as project load)
    if module_index !== nothing && module_index isa AbstractVector
        # Pass 1: containers (folder, module)
        for node in module_index
            node_path_rel = get(node, "path", "")
            node_type = get(node, "type", "")
            meta = get(node, "metadata", Dict())
            if isempty(node_path_rel)
                continue
            end
            full_path = "$(alias).$(node_path_rel)"

            if node_type == "folder"
                folder = PDVTree()
                folder._lazy_registry = tree._lazy_registry
                folder._working_dir = tree._working_dir
                folder._save_dir = tree._save_dir
                folder._path_prefix = full_path
                _set_tree_node_silent!(tree, full_path, folder)
            elseif node_type == "module"
                storage = get(node, "storage", Dict())
                old_meta = get(storage, "value", Dict())
                mod = PDVModule(
                    get(meta, "module_id", get(old_meta, "module_id", mid)),
                    get(meta, "name", get(old_meta, "name", name)),
                    get(meta, "version", get(old_meta, "version", version)),
                )
                ct = children_tree(mod)
                ct._lazy_registry = tree._lazy_registry
                ct._working_dir = tree._working_dir
                ct._save_dir = tree._save_dir
                ct._path_prefix = full_path
                _set_tree_node_silent!(tree, full_path, mod)
            end
        end

        # Pass 2: leaves
        for node in module_index
            node_path_rel = get(node, "path", "")
            node_type = get(node, "type", "")
            storage = get(node, "storage", Dict())
            backend = get(storage, "backend", "")
            meta = get(node, "metadata", Dict())
            if isempty(node_path_rel) || node_type in ("folder", "module")
                continue
            end
            full_path = "$(alias).$(node_path_rel)"
            rel_path = get(storage, "relative_path", "")

            if node_type == "script"
                lang = get(meta, "language", get(node, "language", "julia"))
                doc_str = get(meta, "doc", nothing)
                _set_tree_node_silent!(tree, full_path,
                    PDVScript(rel_path; language=lang, doc=doc_str))
            elseif node_type == "markdown"
                title_str = get(meta, "title", nothing)
                _set_tree_node_silent!(tree, full_path,
                    PDVNote(rel_path; title=title_str))
            elseif node_type == "gui"
                mod_id = get(meta, "module_id", mid)
                gui_node = PDVGui(rel_path; module_id=mod_id)
                _set_tree_node_silent!(tree, full_path, gui_node)
                parts = split(full_path, ".")
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
                mod_id = get(meta, "module_id", mid)
                nml_fmt = get(meta, "namelist_format", get(node, "namelist_format", "auto"))
                _set_tree_node_silent!(tree, full_path,
                    PDVNamelist(rel_path; format=nml_fmt, module_id=mod_id))
            elseif node_type == "lib"
                mod_id = get(meta, "module_id", mid)
                _set_tree_node_silent!(tree, full_path,
                    PDVLib(rel_path; module_id=mod_id))
            elseif backend == "inline"
                _set_tree_node_silent!(tree, full_path, get(storage, "value", nothing))
            else
                register!(tree._lazy_registry, full_path, storage)
            end
        end
    end

    send_message("pdv.module.register.response",
                 Dict{String,Any}("path" => alias, "module_id" => mid);
                 in_reply_to=msg_id)
end

function handle_modules_setup(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    modules_list = get(payload, "modules", [])

    for mod_info in modules_list
        lib_paths = get(mod_info, "lib_paths", [])
        lib_dir = get(mod_info, "lib_dir", nothing)
        entry_point = get(mod_info, "entry_point", nothing)

        # v4: add lib_dir directly to LOAD_PATH
        if lib_dir !== nothing && !isempty(lib_dir) && isdir(lib_dir) && !(lib_dir in LOAD_PATH)
            pushfirst!(LOAD_PATH, lib_dir)
        end

        # Legacy: add parent directories of individual lib files to LOAD_PATH
        for file_path in lib_paths
            parent_dir = dirname(file_path)
            if !isempty(parent_dir) && !(parent_dir in LOAD_PATH)
                pushfirst!(LOAD_PATH, parent_dir)
            end
        end

        # entry_point loading is handled by run_script() at execution time:
        # it finds the parent PDVModule's lib branch and pre-includes all
        # PDVLib files into the script's anonymous module. Base.require()
        # does not work for bare .jl module files (only proper packages).
    end

    send_message("pdv.modules.setup.response",
                 Dict{String,Any}("handlers" => get_handler_registry());
                 in_reply_to=msg_id)
end

function handle_handler_invoke(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    path = get(payload, "path", "")

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.handler.invoke.response", "tree.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    if !haskey(tree, path)
        send_error("pdv.handler.invoke.response", "tree.path_not_found",
                   "No node at path: '$path'"; in_reply_to=msg_id)
        return
    end

    value = try
        tree[path]
    catch e
        send_error("pdv.handler.invoke.response", "tree.load_error",
                   string(e); in_reply_to=msg_id)
        return
    end

    result = dispatch_handler(value, path, tree)
    send_message("pdv.handler.invoke.response", result; in_reply_to=msg_id)
end
