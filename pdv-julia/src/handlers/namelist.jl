# handlers/namelist.jl — pdv.namelist.read / pdv.namelist.write /
# pdv.file.register handlers.
#
# Port of pdv/handlers/namelist.py.

"""
    handle_namelist_read(msg)

Handle `pdv.namelist.read`: parse a `PDVNamelist` backing file and return
groups, hints, inferred types, and the effective format.
"""
function handle_namelist_read(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    resolved = resolve_namelist_node(msg, "pdv.namelist.read.response")
    resolved === nothing && return nothing
    _tree, node, file_path, _payload = resolved

    local groups, hints, types, fmt
    try
        fmt = node.format
        groups = read_namelist(file_path; format=fmt)
        hints = extract_hints(file_path; format=fmt)
        types = infer_types(groups)
        fmt == "auto" && (fmt = detect_namelist_format(file_path))
    catch err
        send_error("pdv.namelist.read.response", "namelist.read_error",
                   "Failed to read namelist: $(sprint(showerror, err))";
                   in_reply_to=msg_id)
        return nothing
    end

    send_message("pdv.namelist.read.response", Dict{String,Any}(
        "groups" => groups, "hints" => hints, "types" => types, "format" => fmt);
        in_reply_to=msg_id)
    nothing
end

"""
    handle_namelist_write(msg)

Handle `pdv.namelist.write`: write structured data back to a `PDVNamelist`
backing file.
"""
function handle_namelist_write(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    resolved = resolve_namelist_node(msg, "pdv.namelist.write.response")
    resolved === nothing && return nothing
    _tree, node, file_path, payload = resolved
    data = get(payload, "data", Dict{String,Any}())
    data isa AbstractDict || (data = Dict{String,Any}())

    try
        write_namelist(file_path, data; format=node.format)
    catch err
        send_error("pdv.namelist.write.response", "namelist.write_error",
                   "Failed to write namelist: $(sprint(showerror, err))";
                   in_reply_to=msg_id)
        return nothing
    end

    send_message("pdv.namelist.write.response", Dict{String,Any}("success" => true);
                 in_reply_to=msg_id)
    nothing
end

"""
    handle_file_register(msg)

Handle `pdv.file.register`: create a file-backed tree node (`PDVNamelist`,
`PDVLib`, `PDVHdf5`, or generic `PDVFile` — with HDF5 extension autodetect
in the generic branch) at `tree_path`. Lib registrations also load
the lib file into `Main` so its module becomes importable by scripts — the
Julia analog of Python's `sys.path` insertion.
"""
function handle_file_register(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.file.register.response", "file";
                                          required_fields=("filename",))
    validated === nothing && return nothing
    tree, payload = validated
    tree_path = string(get(payload, "tree_path", ""))
    filename = string(get(payload, "filename", ""))
    node_type = string(get(payload, "node_type", "file"))
    explicit_name = string(get(payload, "name", ""))
    module_id_raw = get(payload, "module_id", nothing)
    module_id = module_id_raw === nothing ? nothing : string(module_id_raw)
    src_rel_raw = get(payload, "source_rel_path", nothing)
    src_rel = src_rel_raw === nothing ? nothing : string(src_rel_raw)

    node_uuid = string(get(payload, "uuid", ""))
    isempty(node_uuid) && (node_uuid = generate_node_uuid())

    node_name = if !isempty(explicit_name)
        explicit_name
    else
        # Derive from the filename stem, stripping double extensions.
        # `splitext` treats a leading-dot name (".bashrc", ".env.local") as
        # all-stem, so strip only while the stem keeps shrinking — the
        # unconditional `while occursin(".", stem)` spun forever on
        # dotfiles, pegging comm dispatch until kernel restart (second
        # review; same fix in pdv-python).
        stem = first(splitext(filename))
        while occursin(".", stem)
            shorter = first(splitext(stem))
            shorter == stem && break
            stem = shorter
        end
        stem
    end
    # Dots are tree-path separators, so a dotfile stem (".bashrc") must not
    # survive into the node name.
    node_name = replace(node_name, "-" => "_", " " => "_", "." => "_")

    full_path = isempty(tree_path) ? node_name : "$tree_path.$node_name"

    node = if node_type == "namelist"
        PDVNamelist(uuid=node_uuid, filename=filename, format="auto",
                    module_id=module_id, source_rel_path=src_rel)
    elseif node_type == "lib"
        PDVLib(uuid=node_uuid, filename=filename, module_id=module_id,
               source_rel_path=src_rel)
    elseif node_type == "hdf5_file"
        preload_hdf5!()
        PDVHdf5(uuid=node_uuid, filename=filename, source_rel_path=src_rel)
    else
        # Generic file: autodetect HDF5 by extension so the GUI "Add File"
        # flow matches `PDVKernel.add_file` (Python parity; a `.nc` file
        # stays a plain PDVFile — the Julia kernel has no PDVDataset yet).
        ext = lowercase(last(splitext(filename)))
        if ext in HDF5_EXTENSIONS
            preload_hdf5!()
            PDVHdf5(uuid=node_uuid, filename=filename, source_rel_path=src_rel)
        else
            PDVFile(uuid=node_uuid, filename=filename, source_rel_path=src_rel)
        end
    end

    tree[full_path] = node

    if node_type == "lib" && tree.working_dir !== nothing
        abs_path = resolve_path(node, tree.working_dir)
        alias = first(split(full_path, "."))
        if isfile(abs_path)
            try
                load_lib_file!(abs_path; alias=String(alias))
            catch err
                @warn "Failed to load new lib file '$abs_path'" exception = err
            end
        end
    end

    send_message("pdv.file.register.response", Dict{String,Any}("path" => full_path);
                 in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.namelist.read", handle_namelist_read)
register_message_handler("pdv.namelist.write", handle_namelist_write)
register_message_handler("pdv.file.register", handle_file_register)
