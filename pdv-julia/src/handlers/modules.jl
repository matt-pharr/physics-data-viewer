# handlers/modules.jl — Module registration, setup, and handler invocation.
#
# Port of pdv/handlers/modules.py: pdv.module.register / create_empty /
# update / reload_libs, pdv.modules.setup, and pdv.handler.invoke.
#
# The Julia analog of Python's sys.path wiring: PDVLib files are `include`d
# into `Main` (via load_lib_file!), which both defines their modules and lets
# them extend PDVKernel's pdv_handle / pdv_preview / serializer protocol.

"""
    handle_module_register(msg)

Handle `pdv.module.register`: create (or update in place) a `PDVModule` at
the alias path, then mount the v4 `module_index` subtree with the same
two-pass loader as project load (`conflict_strategy="skip"`).
"""
function handle_module_register(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.module.register.response", "module";
                                          required_fields=("path", "module_id"))
    validated === nothing && return nothing
    tree, payload = validated
    alias = string(get(payload, "path", ""))
    module_id = string(get(payload, "module_id", ""))
    name = string(get(payload, "name", ""))
    version = string(get(payload, "version", ""))
    module_index = get(payload, "module_index", nothing)
    dependencies_raw = get(payload, "dependencies", Any[])
    dependencies = Dict{String,Any}[]
    if dependencies_raw isa AbstractVector
        for d in dependencies_raw
            d isa AbstractDict &&
                push!(dependencies, Dict{String,Any}(string(k) => v for (k, v) in pairs(d)))
        end
    end

    working_dir = tree.working_dir === nothing ? "" : tree.working_dir

    # Create the root PDVModule at the alias path; update in place when one
    # already exists (e.g. from project load) to preserve children.
    existing = get(tree, alias, nothing)
    if existing isa PDVModule
        existing.module_id = module_id
        existing.name = name
        existing.version = version
        existing.dependencies = dependencies
    elseif existing isa AbstractDict && !isempty(existing)
        module_node = PDVModule(module_id=module_id, name=name, version=version,
                                dependencies=dependencies)
        for (k, v) in pairs(existing)
            module_node.data[string(k)] = v
        end
        tree[alias] = module_node
    else
        tree[alias] = PDVModule(module_id=module_id, name=name, version=version,
                                dependencies=dependencies)
    end

    if module_index isa AbstractVector && !isempty(module_index)
        load_tree_index(tree, module_index;
                        alias_prefix=alias,
                        conflict_strategy="skip",
                        patch_module_id_on_skip=module_id,
                        module_id_default=module_id,
                        working_dir=working_dir)
    end

    send_message("pdv.module.register.response",
                 Dict{String,Any}("path" => alias, "module_id" => module_id);
                 in_reply_to=msg_id)
    nothing
end

# Yield every PDVLib descendant of a container (any shape).
function _iter_pdv_libs(container, out::Vector{PDVLib}=PDVLib[])
    if container isa PDVLib
        push!(out, container)
        return out
    end
    if container isa AbstractPDVTree
        for child in values(container.data)
            _iter_pdv_libs(child, out)
        end
    elseif container isa AbstractDict
        for child in values(container)
            _iter_pdv_libs(child, out)
        end
    end
    return out
end

"""
    handle_modules_setup(msg)

Handle `pdv.modules.setup`: for each module alias, walk the `PDVModule`
subtree, `include` every `PDVLib` backing file into `Main`, and resolve the
optional entry point. Responds with the handler registry snapshot.
"""
function handle_modules_setup(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())
    modules = get(payload, "modules", Any[])

    tree = get_pdv_tree()
    working_dir = tree === nothing ? nothing : tree.working_dir

    for mod_info in (modules isa AbstractVector ? modules : Any[])
        mod_info isa AbstractDict || continue
        alias = string(get(mod_info, "alias", ""))
        entry_point_raw = get(mod_info, "entry_point", nothing)

        if isempty(alias)
            @warn "pdv.modules.setup entry missing 'alias'; skipping"
            continue
        end

        module_node = tree === nothing ? nothing : get(tree, alias, nothing)
        if !(module_node isa PDVModule)
            @warn "pdv.modules.setup: no PDVModule at alias '$alias'; skipping"
        else
            for lib in _iter_pdv_libs(module_node)
                abs_path = try
                    resolve_path(lib, working_dir)
                catch
                    continue
                end
                isfile(abs_path) || continue
                try
                    load_lib_file!(abs_path; alias=alias)
                catch err
                    @warn "Failed to load lib file '$abs_path'" exception = err
                end
            end
        end

        if entry_point_raw !== nothing && !isempty(string(entry_point_raw))
            _ensure_entry_point(string(entry_point_raw))
        end
    end

    send_message("pdv.modules.setup.response",
                 Dict{String,Any}("handlers" => get_handler_registry());
                 in_reply_to=msg_id)
    nothing
end

"""
    handle_module_create_empty(msg)

Handle `pdv.module.create_empty` (workflow B): create a bare `PDVModule` at
the top of the tree, seeded with empty `scripts` / `lib` / `plots` subtrees.
In-memory only — the main process owns the on-disk scaffolding.
"""
function handle_module_create_empty(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.module.create_empty.response",
                                          "module"; required_fields=("id",))
    validated === nothing && return nothing
    tree, payload = validated
    module_id = string(get(payload, "id", ""))
    name = string(get(payload, "name", ""))
    isempty(name) && (name = module_id)
    version = string(get(payload, "version", "0.1.0"))
    isempty(version) && (version = "0.1.0")
    description = string(something(get(payload, "description", ""), ""))
    language = string(something(get(payload, "language", "julia"), ""))
    isempty(language) && (language = "julia")

    if haskey(tree, module_id)
        send_error("pdv.module.create_empty.response", "module.alias_exists",
                   "Tree path already occupied: $(repr(module_id))"; in_reply_to=msg_id)
        return nothing
    end

    mod = PDVModule(module_id=module_id, name=name, version=version,
                    description=description, language=language)
    mod.working_dir = tree.working_dir
    mod.save_dir = tree.save_dir
    for child_key in ("scripts", "lib", "plots")
        child = PDVTree()
        child.working_dir = tree.working_dir
        child.save_dir = tree.save_dir
        mod[child_key] = child
    end
    tree[module_id] = mod

    send_message("pdv.module.create_empty.response",
                 Dict{String,Any}("path" => module_id); in_reply_to=msg_id)
    nothing
end

"""
    handle_module_update(msg)

Handle `pdv.module.update`: patch mutable metadata (`name`, `version`,
`description`) on an existing `PDVModule`; `module_id` and `language` are
immutable.
"""
function handle_module_update(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.module.update.response", "module";
                                          required_fields=("alias",))
    validated === nothing && return nothing
    tree, payload = validated
    alias = string(get(payload, "alias", ""))

    node = try
        tree[alias]
    catch e
        e isa PDVKeyError || rethrow()
        send_error("pdv.module.update.response", "module.not_found",
                   "No node at path: $(repr(alias))"; in_reply_to=msg_id)
        return nothing
    end
    if !(node isa PDVModule)
        send_error("pdv.module.update.response", "module.not_a_module",
                   "Node at $(repr(alias)) is not a PDVModule"; in_reply_to=msg_id)
        return nothing
    end

    name = get(payload, "name", nothing)
    name !== nothing && (node.name = string(name))
    version = get(payload, "version", nothing)
    version !== nothing && (node.version = string(version))
    description = get(payload, "description", nothing)
    description !== nothing && (node.description = string(description))

    send_message("pdv.module.update.response", Dict{String,Any}(
        "alias" => alias, "name" => node.name, "version" => node.version,
        "description" => node.description); in_reply_to=msg_id)
    nothing
end

"""
    handle_module_reload_libs(msg)

Handle `pdv.module.reload_libs`: re-`include` every lib file under the given
module alias so edits take effect on the next script run — the Julia analog
of `importlib.reload`. Fired as a `script:run` preflight for every run, so
the non-module case must stay cheap.
"""
function handle_module_reload_libs(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())
    alias = string(get(payload, "alias", ""))

    if isempty(alias)
        send_error("pdv.module.reload_libs.response", "module.missing_alias",
                   "alias is required in pdv.module.reload_libs payload";
                   in_reply_to=msg_id)
        return nothing
    end

    tree = get_pdv_tree()
    working_dir = tree === nothing ? nothing : tree.working_dir

    node = tree === nothing ? nothing : get(tree, alias, nothing)
    reloaded = String[]
    errors = Dict{String,Any}()

    if node isa PDVModule && working_dir !== nothing
        for lib in _iter_pdv_libs(node)
            abs_path = try
                resolve_path(lib, working_dir)
            catch
                continue
            end
            isfile(abs_path) || continue
            try
                mod_name = load_lib_file!(abs_path; alias=alias)
                push!(reloaded, mod_name === nothing ?
                    first(splitext(basename(abs_path))) : string(mod_name))
            catch err
                errors[first(splitext(basename(abs_path)))] =
                    "$(typeof(err)): $(sprint(showerror, err))"
            end
        end
    end

    send_message("pdv.module.reload_libs.response", Dict{String,Any}(
        "reloaded" => reloaded, "errors" => errors); in_reply_to=msg_id)
    nothing
end

"""
    handle_handler_invoke(msg)

Handle `pdv.handler.invoke`: dispatch the registered double-click handler
for the node at `path`.
"""
function handle_handler_invoke(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.handler.invoke.response", "tree";
                                          required_fields=())
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))

    if !haskey(tree, path)
        send_error("pdv.handler.invoke.response", "tree.path_not_found",
                   "No node at path: '$path'"; in_reply_to=msg_id)
        return nothing
    end
    value = try
        tree[path]
    catch err
        send_error("pdv.handler.invoke.response", "tree.load_error",
                   sprint(showerror, err); in_reply_to=msg_id)
        return nothing
    end

    result = dispatch_handler(value, path, tree)
    send_message("pdv.handler.invoke.response", result; in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.module.register", handle_module_register)
register_message_handler("pdv.module.create_empty", handle_module_create_empty)
register_message_handler("pdv.module.update", handle_module_update)
register_message_handler("pdv.modules.setup", handle_modules_setup)
register_message_handler("pdv.module.reload_libs", handle_module_reload_libs)
register_message_handler("pdv.handler.invoke", handle_handler_invoke)
