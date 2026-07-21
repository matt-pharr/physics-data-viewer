# handlers/project.jl — Handlers for PDV project messages.
#
# Port of pdv/handlers/project.py: pdv.project.load / pdv.project.save /
# pdv.project.clear_autosave_cache, plus the shared serialize_tree_to_dir
# core and the in-memory autosave checksum cache (ARCHITECTURE.md §8).

# In-memory autosave checksum cache: tree_path => (digest, descriptor).
const _autosave_cache = Ref{AutosaveCache}(AutosaveCache())

"""Clear the in-memory autosave checksum cache."""
clear_autosave_cache!() = (_autosave_cache[] = AutosaveCache(); nothing)

# Count total nodes in a tree recursively (no I/O).
function _count_nodes(tree)::Int
    count = 0
    for key in keys(tree.data)
        count += 1
        value = tree.data[key]
        value isa AbstractPDVTree && (count += _count_nodes(value))
    end
    return count
end

# Uniform raw-key iteration across AbstractPDVTree and plain Dicts (composite
# containers reached during recursion). The walker only recurses into Dicts
# the serializer classified composite, and composite now implies all-String
# keys (serialization.jl `_serialize_mapping!`; non-String-keyed Dicts
# persist whole as .jls leaves) — so plain indexing cannot KeyError here.
_container_keys(c::AbstractPDVTree) = collect(keys(c.data))
_container_keys(c::AbstractDict) = collect(string(k) for k in keys(c))
_container_value(c::AbstractPDVTree, k::String) = c.data[k]
_container_value(c::AbstractDict, k::String) = c[k]

"""
    _collect_nodes(tree, save_dir; ...) -> Vector{Dict}

Recursively serialize tree nodes and return the descriptor list. Values that
`serialize_node` refuses fall back to an unconditional `.jls` write, except
missing backing files, which are recorded in `missing_files` and skipped
(the save then aborts before tree-index.json is written).

Unlike the Python walker, the rescue is not limited to
`PDVSerializationError`: Julia's `Serialization` refuses more values than
pickle does (running `Task`s, open `Channel`s, ...), so any error escaping
`serialize_node` triggers the jls fallback, and a value that even the
fallback cannot write is skipped and recorded in `failed_nodes` — one
unserializable leaf must never abort the whole save. When `prior_index`
holds the node's descriptor from the previous save, the descriptor (and its
children's) is re-used instead, so the last good on-disk snapshot survives
both the new tree-index.json and the orphan purge (PR #347 review M1).
"""
function _collect_nodes(tree, save_dir::String; prefix::String="",
                        working_dir::String="",
                        on_progress::Union{Nothing,Function}=nothing,
                        counter::Ref{Int}=Ref(0),
                        missing_files::Union{Nothing,Vector{String}}=nothing,
                        failed_nodes::Union{Nothing,Vector{Dict{String,Any}}}=nothing,
                        autosave_cache::Union{Nothing,AutosaveCache}=nothing,
                        autosave_hits::Union{Nothing,Ref{Int}}=nothing,
                        prior_index::Union{Nothing,Vector{Any}}=nothing)
    nodes = Dict{String,Any}[]
    for key in _container_keys(tree)
        path = isempty(prefix) ? key : "$prefix.$key"
        value = _container_value(tree, key)
        descriptor = try
            serialize_node(path, value, save_dir; trusted=true,
                           source_dir=isempty(working_dir) ? save_dir : working_dir,
                           autosave_cache=autosave_cache, autosave_hits=autosave_hits)
        catch err
            err isa InterruptException && rethrow()
            if err isa PDVSerializationError && missing_files !== nothing &&
               startswith(error_message(err), "File not found:")
                @warn "project.save: skipping node '$path' — backing file missing: $(error_message(err))"
                push!(missing_files, path)
                counter[] += 1
                on_progress !== nothing && on_progress(counter[])
                continue
            end
            reason = err isa PDVSerializationError ? error_message(err) :
                sprint(showerror, err)
            @warn "project.save: falling back to jls for node '$path' ($(typeof(value))): $reason"
            try
                jls_fallback_node(path, value, save_dir)
            catch fallback_err
                fallback_err isa InterruptException && rethrow()
                fb_reason = sprint(showerror, fallback_err)
                preserved = _preserve_prior_descriptors!(nodes, prior_index, path)
                if preserved
                    @warn "project.save: node '$path' ($(typeof(value))) could not be serialized — keeping its previously saved snapshot: $fb_reason"
                else
                    @warn "project.save: node '$path' ($(typeof(value))) could not be serialized at all — skipping: $fb_reason"
                end
                failed_nodes !== nothing && push!(failed_nodes, Dict{String,Any}(
                    "path" => path, "type" => string(typeof(value)),
                    "error" => fb_reason, "preserved" => preserved))
                counter[] += 1
                on_progress !== nothing && on_progress(counter[])
                continue
            end
        end
        push!(nodes, descriptor)
        counter[] += 1
        on_progress !== nothing && on_progress(counter[])
        if value isa AbstractPDVTree ||
           (get(get(descriptor, "metadata", Dict{String,Any}()), "composite", false) == true &&
            value isa AbstractDict)
            append!(nodes, _collect_nodes(value, save_dir; prefix=path,
                                          working_dir=working_dir,
                                          on_progress=on_progress, counter=counter,
                                          missing_files=missing_files,
                                          failed_nodes=failed_nodes,
                                          autosave_cache=autosave_cache,
                                          autosave_hits=autosave_hits,
                                          prior_index=prior_index))
        end
    end
    return nodes
end

"""
    _preserve_prior_descriptors!(nodes, prior_index, path) -> Bool

When a node cannot be serialized at all, re-append its descriptor (and its
children's, for prior composites/subtrees) from the previous save's
tree-index.json. The node then stays in the new index and its `tree/<uuid>/`
snapshot survives `_purge_orphaned_tree_files` — the alternative silently
destroys the last good copy of the data (PR #347 review M1). Returns whether
anything was preserved.
"""
function _preserve_prior_descriptors!(nodes::Vector{Dict{String,Any}},
                                      prior_index::Union{Nothing,Vector{Any}},
                                      path::String)::Bool
    prior_index === nothing && return false
    preserved = false
    child_prefix = path * "."
    for entry in prior_index
        entry isa AbstractDict || continue
        entry_path = string(get(entry, "path", ""))
        if entry_path == path || startswith(entry_path, child_prefix)
            push!(nodes, Dict{String,Any}(entry))
            preserved = true
        end
    end
    return preserved
end

"""
    _purge_orphaned_tree_files(save_dir, nodes)

Remove `<save_dir>/tree/<uuid>/` directories not referenced by `nodes`. Data
nodes mint a fresh UUID on every save; the previous UUID directory is an
orphan once tree-index.json has been written.
"""
function _purge_orphaned_tree_files(save_dir::String, nodes::Vector{Dict{String,Any}})
    tree_dir = joinpath(save_dir, "tree")
    isdir(tree_dir) || return nothing

    referenced = Set{String}()
    for node in nodes
        node_uuid = string(get(node, "uuid", ""))
        isempty(node_uuid) || push!(referenced, node_uuid)
        storage = get(node, "storage", Dict{String,Any}())
        storage isa AbstractDict || continue
        storage_uuid = string(get(storage, "uuid", ""))
        isempty(storage_uuid) || push!(referenced, storage_uuid)
    end

    entries = try
        readdir(tree_dir)
    catch
        return nothing
    end
    for entry in entries
        entry in referenced && continue
        occursin(NODE_UUID_RE, entry) || continue
        orphan_path = joinpath(tree_dir, entry)
        isdir(orphan_path) || continue
        try
            rm(orphan_path; recursive=true, force=true)
        catch err
            @debug "Failed to remove orphaned tree dir $orphan_path" exception = err
        end
    end
    nothing
end

"""
    _collect_module_owned_files(tree, working_dir; current_module_id="") -> Vector

Walk the tree and return every file-backed node that belongs to a PDVModule,
as `{"module_id", "source_rel_path", "workdir_path"}` entries — consumed by
the main process's save-time module mirror (ARCHITECTURE.md §5.13).
"""
function _collect_module_owned_files(tree, working_dir::String;
                                     current_module_id::String="")
    results = Dict{String,Any}[]
    for key in _container_keys(tree)
        value = _container_value(tree, key)
        if value isa PDVModule
            append!(results, _collect_module_owned_files(value, working_dir;
                                                         current_module_id=value.module_id))
        elseif value isa AbstractPDVTree
            append!(results, _collect_module_owned_files(value, working_dir;
                                                         current_module_id=current_module_id))
        elseif value isa AbstractPDVFile
            src_rel = value.source_rel_path
            (src_rel === nothing || isempty(src_rel)) && continue
            own_id = hasproperty(value, :module_id) && value.module_id !== nothing ?
                String(value.module_id) : ""
            mod_id = !isempty(current_module_id) ? current_module_id : own_id
            isempty(mod_id) && continue
            workdir_path = resolve_path(value, working_dir)
            isabspath(workdir_path) || (workdir_path = joinpath(working_dir, workdir_path))
            push!(results, Dict{String,Any}(
                "module_id" => mod_id,
                "source_rel_path" => src_rel,
                "workdir_path" => workdir_path,
            ))
        end
    end
    return results
end

# Module-manifest storage formats per node kind (module-index.json uses
# module-root-relative descriptors).
const _MANIFEST_FORMAT_MAP = Dict{String,String}(
    "script" => FORMAT_JL_SCRIPT, "lib" => FORMAT_JL_LIB, "gui" => FORMAT_GUI_JSON,
    "namelist" => FORMAT_NAMELIST, "markdown" => FORMAT_MARKDOWN,
)

function _manifest_descriptor(rel_path::String, key::String, parent_rel::String, value)
    kind = detect_kind(value)
    preview_str = node_preview(value, kind)
    descriptor = Dict{String,Any}(
        "id" => rel_path, "path" => rel_path, "key" => key,
        "parent_path" => parent_rel, "type" => kind,
        "has_children" => value isa AbstractPDVTree, "lazy" => false,
    )

    if value isa PDVModule
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "inline", "format" => FORMAT_MODULE_META,
            "value" => Dict{String,Any}("module_id" => value.module_id,
                                        "name" => value.name, "version" => value.version))
        descriptor["metadata"] = Dict{String,Any}(
            "module_id" => value.module_id, "name" => value.name,
            "version" => value.version, "preview" => preview_str)
        return descriptor
    end
    if value isa AbstractPDVTree
        descriptor["storage"] = Dict{String,Any}("backend" => "none", "format" => "none")
        descriptor["metadata"] = Dict{String,Any}("preview" => preview_str)
        return descriptor
    end
    if value isa AbstractPDVFile
        descriptor["uuid"] = value.uuid
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file", "uuid" => value.uuid,
            "filename" => value.filename,
            "format" => get(_MANIFEST_FORMAT_MAP, kind, "file"))
        meta = Dict{String,Any}("preview" => preview_str)
        if value.source_rel_path !== nothing && !isempty(value.source_rel_path)
            descriptor["source_rel_path"] = value.source_rel_path
        end
        if kind == "script"
            meta["language"] = value.language
            meta["doc"] = value.doc
            isempty(value.module_id) || (meta["module_id"] = value.module_id)
        elseif kind == "lib"
            meta["language"] = "julia"
            value.module_id !== nothing && (meta["module_id"] = value.module_id)
        elseif kind == "gui"
            meta["language"] = "json"
            value.module_id !== nothing && (meta["module_id"] = value.module_id)
        elseif kind == "namelist"
            meta["language"] = "namelist"
            meta["namelist_format"] = value.format
            value.module_id !== nothing && (meta["module_id"] = value.module_id)
        end
        descriptor["metadata"] = meta
        return descriptor
    end

    # Generic / data nodes — minimal folder-like descriptor (see the Python
    # port's note on workflow B data packaging).
    descriptor["storage"] = Dict{String,Any}("backend" => "none", "format" => "none")
    descriptor["metadata"] = Dict{String,Any}("preview" => preview_str)
    return descriptor
end

"""
    _collect_module_manifests(tree) -> Vector

Emit one manifest entry per top-level PDVModule: identity metadata plus
module-root-relative node descriptors, consumed by the main process to write
`pdv-module.json` / `module-index.json` (ARCHITECTURE.md §5.13).
"""
function _collect_module_manifests(tree)
    function walk(subtree, parent_rel::String, entries::Vector{Dict{String,Any}})
        for child_key in _container_keys(subtree)
            child_value = _container_value(subtree, child_key)
            child_rel = isempty(parent_rel) ? child_key : "$parent_rel.$child_key"
            push!(entries, _manifest_descriptor(child_rel, child_key, parent_rel, child_value))
            if child_value isa AbstractPDVTree && !(child_value isa PDVModule)
                walk(child_value, child_rel, entries)
            end
        end
    end

    results = Dict{String,Any}[]
    for key in _container_keys(tree)
        value = _container_value(tree, key)
        value isa PDVModule || continue
        entries = Dict{String,Any}[]
        walk(value, "", entries)
        push!(results, Dict{String,Any}(
            "module_id" => value.module_id,
            "name" => value.name,
            "version" => value.version,
            "description" => value.description,
            "language" => value.language,
            "dependencies" => copy(value.dependencies),
            "entries" => entries,
        ))
    end
    return results
end

"""
    _early_module_setup(nodes, save_dir, working_dir)

Between Pass 1 and Pass 2 of a project load: `include` module lib files into
`Main` (registering custom serializers and `pdv_handle` methods) so Pass 2
can deserialize custom-format data nodes. Failures are logged, never fatal.
"""
function _early_module_setup(nodes::AbstractVector, save_dir::String, working_dir::String)
    # alias => module_id from module-type nodes; lib entries carry their files.
    module_ids = Dict{String,String}()
    lib_files = Vector{Tuple{String,String}}()  # (alias, abs file path)

    for node in nodes
        node isa AbstractDict || continue
        node_type = get(node, "type", "")
        node_path = string(get(node, "path", ""))
        if node_type == "module"
            meta = get(node, "metadata", Dict{String,Any}())
            storage = get(node, "storage", Dict{String,Any}())
            old_meta = storage isa AbstractDict ? get(storage, "value", Dict{String,Any}()) :
                Dict{String,Any}()
            old_meta isa AbstractDict || (old_meta = Dict{String,Any}())
            module_id = string(get(meta, "module_id", get(old_meta, "module_id", "")))
            isempty(module_id) || (module_ids[node_path] = module_id)
        elseif node_type == "lib"
            storage = get(node, "storage", Dict{String,Any}())
            storage isa AbstractDict || continue
            node_uuid = string(get(node, "uuid", get(storage, "uuid", "")))
            filename = string(get(storage, "filename", ""))
            if !isempty(node_uuid) && !isempty(filename) && !isempty(working_dir)
                alias = first(split(node_path, "."))
                push!(lib_files, (String(alias), uuid_tree_path(working_dir, node_uuid, filename)))
            end
        end
    end

    for (alias, lib_file) in lib_files
        isfile(lib_file) || continue
        try
            load_lib_file!(lib_file; alias=alias)
        catch err
            @warn "Early module setup: failed to load lib '$lib_file'" exception = err
        end
    end

    # Entry points: resolve from <save_dir>/modules/<id>/pdv-module.json. The
    # lib include above usually already defined the entry module in Main.
    for (alias, module_id) in module_ids
        manifest_path = joinpath(save_dir, "modules", module_id, "pdv-module.json")
        isfile(manifest_path) || continue
        manifest = try
            JSON.parsefile(manifest_path)
        catch
            continue
        end
        entry_point = get(manifest, "entry_point", nothing)
        (entry_point === nothing || isempty(entry_point)) && continue
        _ensure_entry_point(string(entry_point))
    end
    nothing
end

# Ensure a module entry point is resolvable: already defined in Main by a lib
# include, or importable as a package.
function _ensure_entry_point(entry_point::String)
    sym = Symbol(entry_point)
    isdefined(Main, sym) && getfield(Main, sym) isa Module && return nothing
    try
        Core.eval(Main, :(import $sym))
    catch err
        @warn "Failed to load module entry point '$entry_point'" exception = err
    end
    nothing
end

"""
    serialize_tree_to_dir(tree, save_dir; on_progress=nothing,
                          autosave_cache=nothing) -> Dict

Serialize the in-memory tree to `save_dir` and return save metadata —
the core shared by `handle_project_save` and the `save_project` API. See
pdv-python's `serialize_tree_to_dir` for the full abort-semantics contract
(a non-empty `missing_files` aborts before tree-index.json is written).
"""
function serialize_tree_to_dir(tree, save_dir::AbstractString;
                               on_progress::Union{Nothing,Function}=nothing,
                               autosave_cache::Union{Nothing,AutosaveCache}=nothing)
    save_dir = String(save_dir)
    mkpath(joinpath(save_dir, "tree"))

    working_dir = tree.working_dir === nothing ? save_dir : tree.working_dir
    total = _count_nodes(tree)

    # Immediate 0/total emission so the renderer's bar appears before the
    # walk starts (first-save JIT and a single multi-GB file copy both live
    # inside one node tick — without this a small tree's only emission is
    # current == total, which the renderer treats as "done, clear the bar",
    # and the whole save shows no feedback at all). Small trees then emit
    # every node; the %5 throttle is for large trees where per-node comm
    # messages are meaningful overhead.
    on_progress !== nothing && on_progress("Serializing", 0, total)
    emit_progress = function (current::Int)
        if total <= 20 || current % 5 == 0 || current == total
            on_progress !== nothing && on_progress("Serializing", current, total)
        end
    end

    # Previous save's index, consulted only to preserve the last good
    # snapshot of nodes that fail to serialize (see
    # `_preserve_prior_descriptors!`). Never used for current values.
    prior_index = nothing
    prior_index_path = joinpath(save_dir, "tree-index.json")
    if isfile(prior_index_path)
        prior_index = try
            parsed = JSON.parsefile(prior_index_path)
            parsed isa AbstractVector ? convert(Vector{Any}, parsed) : nothing
        catch
            nothing
        end
    end

    missing_files = String[]
    failed_nodes = Dict{String,Any}[]
    autosave_hits = Ref(0)
    nodes = _collect_nodes(tree, save_dir; working_dir=working_dir,
                           on_progress=emit_progress, missing_files=missing_files,
                           failed_nodes=failed_nodes,
                           autosave_cache=autosave_cache, autosave_hits=autosave_hits,
                           prior_index=prior_index)
    if !isempty(missing_files)
        return Dict{String,Any}(
            "node_count" => length(nodes), "checksum" => "", "aborted" => true,
            "module_owned_files" => Any[], "module_manifests" => Any[],
            "missing_files" => missing_files, "failed_nodes" => failed_nodes,
            "autosave_cache_hits" => autosave_hits[],
        )
    end

    index_data = JSON.json(nodes, 2)
    index_path = joinpath(save_dir, "tree-index.json")
    tmp_path = index_path * ".tmp"
    open(io -> write(io, index_data), tmp_path, "w")
    mv(tmp_path, index_path; force=true)

    _purge_orphaned_tree_files(save_dir, nodes)

    if autosave_cache !== nothing
        live_paths = Set(string(node["path"]) for node in nodes)
        for stale in [p for p in keys(autosave_cache) if !(p in live_paths)]
            delete!(autosave_cache, stale)
        end
    end

    checksum = tree_checksum(tree)
    module_owned_files = _collect_module_owned_files(tree, working_dir)
    module_manifests = _collect_module_manifests(tree)

    return Dict{String,Any}(
        "node_count" => length(nodes),
        "checksum" => checksum,
        "aborted" => false,
        "module_owned_files" => module_owned_files,
        "module_manifests" => module_manifests,
        "missing_files" => missing_files,
        "failed_nodes" => failed_nodes,
        "autosave_cache_hits" => autosave_hits[],
    )
end

"""
    handle_project_load(msg)

Handle `pdv.project.load`: rebuild the tree from `tree-index.json` (honoring
the optional `tree_index_dir` autosave-recovery override), then send the
response and the `pdv.project.loaded` push (ARCHITECTURE.md §4.2, §8.4).
"""
function handle_project_load(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.project.load.response", "project";
                                          required_fields=("save_dir",))
    validated === nothing && return nothing
    tree, payload = validated
    save_dir = string(get(payload, "save_dir", ""))
    tree_index_dir = string(get(payload, "tree_index_dir", ""))

    if !isdir(save_dir)
        send_error("pdv.project.load.response", "project.invalid_save_dir",
                   "save_dir does not exist or is not a directory: '$save_dir'";
                   in_reply_to=msg_id)
        return nothing
    end
    if !isempty(tree_index_dir) && !isdir(tree_index_dir)
        @warn "tree_index_dir override missing, falling back to save_dir: '$tree_index_dir'"
    end
    index_source = (!isempty(tree_index_dir) && isdir(tree_index_dir)) ? tree_index_dir : save_dir
    tree_index_path = joinpath(index_source, "tree-index.json")
    if !isfile(tree_index_path)
        send_error("pdv.project.load.response", "project.missing_tree_index",
                   "tree-index.json not found in save directory: '$save_dir'";
                   in_reply_to=msg_id)
        return nothing
    end

    nodes = try
        JSON.parsefile(tree_index_path)
    catch err
        send_error("pdv.project.load.response", "project.corrupt_tree_index",
                   "Failed to parse tree-index.json: $(sprint(showerror, err))";
                   in_reply_to=msg_id)
        return nothing
    end
    if !(nodes isa AbstractVector)
        send_error("pdv.project.load.response", "project.corrupt_tree_index",
                   "tree-index.json does not contain a node array"; in_reply_to=msg_id)
        return nothing
    end

    # Clear the existing in-memory tree (quietly).
    empty!(tree.data)
    tree.save_dir = save_dir

    working_dir = tree.working_dir === nothing ? save_dir : tree.working_dir

    emit_load_progress = function (current::Int, total::Int)
        if current % 5 == 0 || current == total
            send_message("pdv.progress", Dict{String,Any}(
                "operation" => "load", "phase" => "Rebuilding tree",
                "current" => current, "total" => total))
        end
    end

    skipped_nodes = load_tree_index(
        tree, nodes;
        on_progress=emit_load_progress,
        conflict_strategy="replace",
        working_dir=working_dir,
        between_passes=() -> _early_module_setup(nodes, save_dir, working_dir))
    if !isempty(skipped_nodes)
        println(Base.stderr,
                "[pdv] project load: skipped $(length(skipped_nodes)) unloadable node(s): " *
                join(("$(s["path"]) ($(s["error"]))" for s in skipped_nodes), ", "))
    end

    reset_cwd_to_home()
    node_count = length(nodes)
    # Refresh the busy-time query snapshot for the freshly-loaded tree
    # (invokelatest for the same world-age reason as the checksum below).
    Base.invokelatest(rebuild_query_cache!, tree)
    # invokelatest: loading may have Base.require'd packages (jls values from
    # not-yet-loaded packages); the checksum walk must run in that new world
    # or package methods (e.g. DataFrames getindex) are "too new".
    post_load_checksum = Base.invokelatest(tree_checksum, tree)::String

    send_message("pdv.project.load.response", Dict{String,Any}(
        "node_count" => node_count,
        "post_load_checksum" => post_load_checksum,
        "skipped_nodes" => skipped_nodes); in_reply_to=msg_id)
    send_message("pdv.project.loaded", Dict{String,Any}("node_count" => node_count))
    nothing
end

"""
    handle_project_save(msg)

Handle `pdv.project.save`: serialize the tree to the save directory and
reply with node count, checksum, module sync payloads, and abort metadata.
The autosave cache is always consulted and updated; the `clear_cache` flag
wipes it first (ARCHITECTURE.md §8.4).
"""
function handle_project_save(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    raw_payload = get(msg, "payload", Dict{String,Any}())
    if raw_payload isa AbstractDict && get(raw_payload, "clear_cache", false) == true
        clear_autosave_cache!()
    end

    validated = validate_register_request(msg, "pdv.project.save.response", "project";
                                          required_fields=("save_dir",))
    validated === nothing && return nothing
    tree, payload = validated
    save_dir = string(get(payload, "save_dir", ""))

    progress = function (phase::String, current::Int, total::Int)
        send_message("pdv.progress", Dict{String,Any}(
            "operation" => "save", "phase" => phase,
            "current" => current, "total" => total))
    end

    results = try
        serialize_tree_to_dir(tree, save_dir; on_progress=progress,
                              autosave_cache=_autosave_cache[])
    catch err
        println(Base.stderr, "[project.save] FAILED: $(sprint(showerror, err))")
        send_error("pdv.project.save.response", "project.serialization_error",
                   sprint(showerror, err); in_reply_to=msg_id)
        return nothing
    end

    send_message("pdv.project.save.response", results; in_reply_to=msg_id)
    nothing
end

"""
    handle_project_clear_autosave_cache(msg)

Handle `pdv.project.clear_autosave_cache`: reset the in-memory cache so the
next save cannot reuse descriptors whose backing files were just deleted.
"""
function handle_project_clear_autosave_cache(msg::AbstractDict)
    clear_autosave_cache!()
    send_message("pdv.project.clear_autosave_cache.response", Dict{String,Any}();
                 in_reply_to=get(msg, "msg_id", nothing))
    nothing
end

register_message_handler("pdv.project.load", handle_project_load)
register_message_handler("pdv.project.save", handle_project_save)
register_message_handler("pdv.project.clear_autosave_cache", handle_project_clear_autosave_cache)
