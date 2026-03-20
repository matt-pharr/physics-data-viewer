# PDVKernel handlers — module namespace setup and handler invocation.
#
# Handles:
# - pdv.module.register: create a PDVModule in the tree.
# - pdv.modules.setup: add module paths and run entry points.
# - pdv.handler.invoke: dispatch a registered handler for a tree node.

function handle_module_register(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    path = get(payload, "path", "")
    mid = get(payload, "module_id", "")
    name = get(payload, "name", "")
    version = get(payload, "version", "")

    if isempty(path) || isempty(mid)
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

    existing = get(tree, path, nothing)
    if existing isa PDVModule
        existing._module_id = mid
        existing._name = name
        existing._version = version
    elseif existing isa AbstractDict && !isempty(existing)
        module_node = PDVModule(mid, name, version)
        for (k, v) in existing
            module_node[k] = v
        end
        tree[path] = module_node
    else
        tree[path] = PDVModule(mid, name, version)
    end

    send_message("pdv.module.register.response",
                 Dict{String,Any}("path" => path, "module_id" => mid);
                 in_reply_to=msg_id)
end

function handle_modules_setup(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    modules_list = get(payload, "modules", [])

    for mod_info in modules_list
        lib_paths = get(mod_info, "lib_paths", [])
        entry_point = get(mod_info, "entry_point", nothing)

        # Add parent directories to LOAD_PATH
        for file_path in lib_paths
            parent_dir = dirname(file_path)
            if !isempty(parent_dir) && !(parent_dir in LOAD_PATH)
                pushfirst!(LOAD_PATH, parent_dir)
            end
        end

        if entry_point !== nothing && !isempty(entry_point)
            try
                # Import the module by name
                mod_sym = Symbol(entry_point)
                Base.require(Main, mod_sym)
            catch e
                @warn "Failed to import module entry point '$entry_point': $e"
            end
        end
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
