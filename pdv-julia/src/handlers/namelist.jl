# PDVKernel handlers — namelist messages and file registration.
#
# Handles:
# - pdv.namelist.read: parse a namelist file and return structured data.
# - pdv.namelist.write: write structured data back to a namelist file.
# - pdv.file.register: register a file-backed tree node.

function handle_namelist_read(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    tree_path = get(payload, "tree_path", "")

    if isempty(tree_path)
        send_error("pdv.namelist.read.response", "namelist.missing_tree_path",
                   "tree_path is required in pdv.namelist.read payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.namelist.read.response", "namelist.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    node = try
        tree[tree_path]
    catch
        send_error("pdv.namelist.read.response", "namelist.path_not_found",
                   "Tree path not found: '$tree_path'"; in_reply_to=msg_id)
        return
    end

    if !(node isa PDVNamelist)
        send_error("pdv.namelist.read.response", "namelist.wrong_type",
                   "Node at '$tree_path' is not a PDVNamelist (got $(typeof(node)))";
                   in_reply_to=msg_id)
        return
    end

    wd = get_tree_working_dir(tree)
    file_path = resolve_file_path(node, wd)

    try
        fmt = namelist_format(node)
        groups = read_namelist(file_path; format=fmt)
        hints = extract_hints(file_path; format=fmt)
        types = infer_types(groups)
        if fmt == "auto"
            fmt = detect_namelist_format(file_path)
        end

        send_message("pdv.namelist.read.response",
                     Dict{String,Any}("groups" => groups, "hints" => hints,
                                      "types" => types, "format" => fmt);
                     in_reply_to=msg_id)
    catch e
        send_error("pdv.namelist.read.response", "namelist.read_error",
                   "Failed to read namelist: $e"; in_reply_to=msg_id)
    end
end

function handle_namelist_write(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    tree_path = get(payload, "tree_path", "")
    data = get(payload, "data", Dict())

    if isempty(tree_path)
        send_error("pdv.namelist.write.response", "namelist.missing_tree_path",
                   "tree_path is required in pdv.namelist.write payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.namelist.write.response", "namelist.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    node = try
        tree[tree_path]
    catch
        send_error("pdv.namelist.write.response", "namelist.path_not_found",
                   "Tree path not found: '$tree_path'"; in_reply_to=msg_id)
        return
    end

    if !(node isa PDVNamelist)
        send_error("pdv.namelist.write.response", "namelist.wrong_type",
                   "Node at '$tree_path' is not a PDVNamelist (got $(typeof(node)))";
                   in_reply_to=msg_id)
        return
    end

    wd = get_tree_working_dir(tree)
    file_path = resolve_file_path(node, wd)

    try
        write_namelist(file_path, data; format=namelist_format(node))
        send_message("pdv.namelist.write.response",
                     Dict{String,Any}("success" => true); in_reply_to=msg_id)
    catch e
        send_error("pdv.namelist.write.response", "namelist.write_error",
                   "Failed to write namelist: $e"; in_reply_to=msg_id)
    end
end

function handle_file_register(msg::Dict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict())
    tree_path = get(payload, "tree_path", "")
    filename = get(payload, "filename", "")
    node_type = get(payload, "node_type", "file")
    explicit_name = get(payload, "name", "")
    mid = get(payload, "module_id", nothing)

    if isempty(filename)
        send_error("pdv.file.register.response", "file.missing_filename",
                   "filename is required in pdv.file.register payload";
                   in_reply_to=msg_id)
        return
    end

    tree = get_pdv_tree()
    if tree === nothing
        send_error("pdv.file.register.response", "file.no_tree",
                   "PDVTree is not initialized"; in_reply_to=msg_id)
        return
    end

    # Build relative path
    segments = isempty(tree_path) ? String[] : String.(split(tree_path, "."))
    rel_path = isempty(segments) ? filename : joinpath(segments..., filename)

    # Determine node name
    if !isempty(explicit_name)
        node_name = explicit_name
    else
        node_name = splitext(filename)[1]
        while occursin(".", node_name)
            node_name = splitext(node_name)[1]
        end
    end
    node_name = replace(replace(node_name, "-" => "_"), " " => "_")

    full_path = isempty(tree_path) ? node_name : "$tree_path.$node_name"

    if node_type == "namelist"
        node = PDVNamelist(rel_path; format="auto", module_id=mid)
    elseif node_type == "lib"
        node = PDVLib(rel_path; module_id=mid)
    elseif node_type == "hdf5"
        node = PDVHDF5(rel_path)
    else
        # Generic file — use PDVLib as a generic file-backed node
        # (Julia doesn't have a generic PDVFile concrete type since it's abstract)
        node = PDVLib(rel_path; module_id=mid)
    end

    tree[full_path] = node

    send_message("pdv.file.register.response",
                 Dict{String,Any}("path" => full_path); in_reply_to=msg_id)
end
