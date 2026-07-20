# tree_loader.jl — Shared two-pass tree-index loader.
#
# Port of pdv/tree_loader.py. Both `pdv.project.load` and
# `pdv.module.register` reconstruct a PDVTree subtree from a list of node
# descriptors; this is the canonical implementation so the two handlers
# cannot drift.
#
# Pass 1 mounts containers (folder, module, composite mapping); Pass 2 mounts
# leaves. A node that fails to mount is skipped and reported rather than
# aborting the whole load.

"""
    load_tree_index(tree, nodes; alias_prefix="", on_progress=nothing,
                    conflict_strategy="replace", patch_module_id_on_skip=nothing,
                    module_id_default="", working_dir="",
                    between_passes=nothing) -> Vector{Dict}

Mount a tree-index node list into `tree` using the two-pass algorithm.
Returns one `{"path" => ..., "error" => ...}` entry per node that could not
be mounted (empty when every node loaded cleanly). See pdv-python's
`load_tree_index` for the full parameter contract.
"""
function load_tree_index(tree::AbstractPDVTree, nodes::AbstractVector;
                         alias_prefix::AbstractString="",
                         on_progress::Union{Nothing,Function}=nothing,
                         conflict_strategy::AbstractString="replace",
                         patch_module_id_on_skip::Union{Nothing,AbstractString}=nothing,
                         module_id_default::AbstractString="",
                         working_dir::AbstractString="",
                         between_passes::Union{Nothing,Function}=nothing)
    full_path(rel) = isempty(alias_prefix) ? String(rel) : "$alias_prefix.$rel"

    function node_exists(path)
        try
            value = tree[path]
            return (value !== nothing, value)
        catch
            return (false, nothing)
        end
    end

    skipped = Dict{String,Any}[]

    # ── Pass 1: containers ───────────────────────────────────────────────
    for node in nodes
        node isa AbstractDict || continue
        node_path_rel = get(node, "path", "")
        isempty(node_path_rel) && continue
        node_type = get(node, "type", "")
        meta = get(node, "metadata", Dict{String,Any}())
        fp = full_path(node_path_rel)

        if conflict_strategy == "skip"
            exists, _ = node_exists(fp)
            exists && continue
        end

        try
            if node_type == "folder"
                folder = PDVTree()
                folder.working_dir = tree.working_dir
                folder.save_dir = tree.save_dir
                set_quiet!(tree, fp, folder)
            elseif node_type == "mapping" && get(meta, "composite", false) == true
                # Composite mapping: reconstruct as a plain Dict — NOT a
                # PDVTree — so typeof(value) matches what the user stored.
                set_quiet!(tree, fp, Dict{String,Any}())
            elseif node_type == "module"
                storage = get(node, "storage", Dict{String,Any}())
                old_meta = get(storage, "value", Dict{String,Any}())
                old_meta isa AbstractDict || (old_meta = Dict{String,Any}())
                mod = PDVModule(
                    module_id=get(meta, "module_id",
                                  get(old_meta, "module_id", module_id_default)),
                    name=get(meta, "name", get(old_meta, "name", "")),
                    version=get(meta, "version", get(old_meta, "version", "")),
                )
                mod.working_dir = tree.working_dir
                mod.save_dir = tree.save_dir
                set_quiet!(tree, fp, mod)
            end
        catch err
            push!(skipped, Dict{String,Any}("path" => fp, "error" => sprint(showerror, err)))
        end
    end

    between_passes !== nothing && between_passes()

    # ── Pass 2: leaves ───────────────────────────────────────────────────
    total = length(nodes)
    for (index, node) in enumerate(nodes)
        node isa AbstractDict || continue
        node_path_rel = get(node, "path", "")
        if isempty(node_path_rel)
            on_progress !== nothing && on_progress(index, total)
            continue
        end
        node_type = get(node, "type", "")
        meta = get(node, "metadata", Dict{String,Any}())
        meta isa AbstractDict || (meta = Dict{String,Any}())
        if node_type in ("folder", "module") ||
           (node_type == "mapping" && get(meta, "composite", false) == true)
            on_progress !== nothing && on_progress(index, total)
            continue
        end

        fp = full_path(node_path_rel)
        storage = get(node, "storage", Dict{String,Any}())
        storage isa AbstractDict || (storage = Dict{String,Any}())
        backend = get(storage, "backend", "")

        if conflict_strategy == "skip"
            exists, existing_value = node_exists(fp)
            if exists
                if patch_module_id_on_skip !== nothing && node_type == "script" &&
                   existing_value isa PDVScript
                    existing_value.module_id = String(patch_module_id_on_skip)
                end
                on_progress !== nothing && on_progress(index, total)
                continue
            end
        end

        node_uuid = string(get(node, "uuid", get(storage, "uuid", "")))
        node_filename = string(get(storage, "filename", ""))
        if !isempty(node_uuid) &&
           (occursin("..", node_uuid) || occursin("/", node_uuid) || occursin("\\", node_uuid))
            @warn "Skipping node '$node_path_rel' with unsafe UUID: $(repr(node_uuid))"
            push!(skipped, Dict{String,Any}(
                "path" => fp, "error" => "unsafe UUID: $(repr(node_uuid))"))
            on_progress !== nothing && on_progress(index, total)
            continue
        end
        src_rel_raw = get(node, "source_rel_path", nothing)
        src_rel = src_rel_raw === nothing ? nothing : string(src_rel_raw)

        try
            if node_type == "script"
                language = string(get(meta, "language", get(node, "language", "julia")))
                doc_raw = get(meta, "doc", nothing)
                mod_id = string(get(meta, "module_id", module_id_default))
                set_quiet!(tree, fp, PDVScript(
                    uuid=node_uuid, filename=node_filename, language=language,
                    doc=doc_raw === nothing ? nothing : string(doc_raw),
                    module_id=mod_id, source_rel_path=src_rel))
            elseif node_type == "markdown"
                title_raw = get(meta, "title", nothing)
                set_quiet!(tree, fp, PDVNote(
                    uuid=node_uuid, filename=node_filename,
                    title=title_raw === nothing ? nothing : string(title_raw)))
            elseif node_type == "gui"
                mod_id = string(get(meta, "module_id", get(node, "module_id", module_id_default)))
                gui_node = PDVGui(uuid=node_uuid, filename=node_filename,
                                  module_id=mod_id, source_rel_path=src_rel)
                set_quiet!(tree, fp, gui_node)
                # Attach gui reference to parent PDVModule if applicable.
                parts = split(fp, ".")
                if length(parts) > 1
                    parent_path = join(parts[1:end-1], ".")
                    try
                        parent = tree[parent_path]
                        parent isa PDVModule && (parent.gui = gui_node)
                    catch
                    end
                end
            elseif node_type == "namelist"
                mod_id = string(get(meta, "module_id", get(node, "module_id", module_id_default)))
                namelist_format = string(get(meta, "namelist_format",
                                             get(node, "namelist_format", "auto")))
                set_quiet!(tree, fp, PDVNamelist(
                    uuid=node_uuid, filename=node_filename, format=namelist_format,
                    module_id=mod_id, source_rel_path=src_rel))
            elseif node_type == "lib"
                mod_id = string(get(meta, "module_id", get(node, "module_id", module_id_default)))
                set_quiet!(tree, fp, PDVLib(
                    uuid=node_uuid, filename=node_filename, module_id=mod_id,
                    source_rel_path=src_rel))
            elseif node_type == "file"
                set_quiet!(tree, fp, PDVFile(
                    uuid=node_uuid, filename=node_filename, source_rel_path=src_rel))
            elseif backend == "inline"
                # _materialize_inline: tree-index.json comes through JSON.parse,
                # whose 1.x object type is not a Dict (see serialization.jl).
                set_quiet!(tree, fp, _materialize_inline(get(storage, "value", nothing)))
            elseif backend == "local_file"
                # invokelatest: deserializing an earlier leaf may have
                # Base.require'd a package (see _read_jls), advancing the
                # world past this loop's frame; each leaf must see it.
                value = Base.invokelatest(deserialize_node, storage, working_dir;
                                          trusted=true,
                                          value_type=string(get(meta, "python_type", "")))
                set_quiet!(tree, fp, value)
            end
        catch err
            push!(skipped, Dict{String,Any}("path" => fp, "error" => sprint(showerror, err)))
        end

        on_progress !== nothing && on_progress(index, total)
    end

    return skipped
end
