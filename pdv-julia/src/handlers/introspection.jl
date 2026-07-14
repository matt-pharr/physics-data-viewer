# handlers/introspection.jl — pdv.help and pdv.tree.resolve_path handlers.
#
# Port of pdv/handlers/introspection.py. Gives the PDV MCP server read-only
# insight into the kernel namespace and file-backed tree nodes.

# Resolve a dotted symbol string to a live Julia object. The head segment is
# looked up in Main first, then among loaded packages (never triggering a
# package load — the analog of Python's sys.modules-only rule).
function _resolve_symbol(symbol::AbstractString)
    isempty(symbol) && throw(ArgumentError("symbol must be a non-empty string"))
    parts = split(symbol, ".")
    head = Symbol(parts[1])
    local obj
    if isdefined(Main, head)
        obj = getfield(Main, head)
    else
        loaded = loaded_module(head)
        if loaded !== nothing
            obj = loaded
        elseif isdefined(@__MODULE__, head)
            # Bare-name fallback: `pdv.help("PDVScript")` should resolve the
            # way `PDVKernel.PDVScript` would.
            obj = getfield(@__MODULE__, head)
        else
            throw(ArgumentError(
                "Could not resolve '$symbol': '$head' is not loaded in the kernel. " *
                "Try the fully qualified name (e.g. 'PDVKernel.$head') or use a " *
                "variable from the namespace. pdv.help does not load packages."))
        end
    end
    for attr in parts[2:end]
        sym = Symbol(attr)
        if obj isa Module || obj isa Type
            isdefined(obj, sym) || throw(ArgumentError(
                "Could not resolve '$symbol': no field '$attr'"))
            obj = getfield(obj, sym)
        else
            obj = getproperty(obj, sym)
        end
    end
    return obj
end

function _object_kind(obj)::String
    obj isa Module && return "module"
    obj isa Type && return "class"
    obj isa Function && return "function"
    return "object"
end

# Signature summary for a function: its method list, capped for readability.
function _signature_of(obj)
    obj isa Function || obj isa Type || return nothing
    ms = methods(obj)
    isempty(ms) && return nothing
    shown = [sprint(show, m) for m in Iterators.take(ms, 5)]
    suffix = length(ms) > 5 ? "\n… ($(length(ms)) methods total)" : ""
    return join(shown, "\n") * suffix
end

function _doc_of(obj)
    try
        doc = Base.Docs.doc(obj)
        text = string(doc)
        # The default "No documentation found" stub is noise, not docs.
        occursin("No documentation found", text) && return nothing
        return text
    catch
        return nothing
    end
end

function _source_of(obj)
    obj isa Function || return nothing
    try
        ms = collect(methods(obj))
        isempty(ms) && return nothing
        file, line = functionloc(ms[1])
        (file === nothing || !isfile(string(file))) && return nothing
        lines = readlines(string(file))
        line > length(lines) && return nothing
        # Best-effort: from the definition line to the matching `end` at the
        # same indentation, capped at 200 lines.
        first_line = lines[line]
        indent = length(first_line) - length(lstrip(first_line))
        stop = min(length(lines), line + 200)
        for i in (line + 1):stop
            stripped = strip(lines[i])
            line_indent = length(lines[i]) - length(lstrip(lines[i]))
            if stripped == "end" && line_indent <= indent
                stop = i
                break
            end
        end
        return join(lines[line:stop], "\n")
    catch
        return nothing
    end
end

"""
    handle_help(msg)

Handle `pdv.help`: resolve a dotted symbol and return kind, signature,
docstring, and (optionally) source.
"""
function handle_help(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    payload = get(msg, "payload", Dict{String,Any}())
    payload isa AbstractDict || (payload = Dict{String,Any}())
    symbol = string(get(payload, "symbol", ""))
    include_source = get(payload, "include_source", false) == true

    if isempty(symbol)
        send_error("pdv.help.response", "introspection.missing_symbol",
                   "symbol is required in pdv.help payload"; in_reply_to=msg_id)
        return nothing
    end

    obj = try
        _resolve_symbol(symbol)
    catch err
        send_error("pdv.help.response", "introspection.symbol_not_found",
                   "Could not resolve symbol '$symbol': $(sprint(showerror, err))";
                   in_reply_to=msg_id)
        return nothing
    end

    send_message("pdv.help.response", Dict{String,Any}(
        "symbol" => symbol,
        "kind" => _object_kind(obj),
        "signature" => _signature_of(obj),
        "doc" => _doc_of(obj),
        "source" => include_source ? _source_of(obj) : nothing);
        in_reply_to=msg_id)
    nothing
end

# Recursively collect (tree_path, AbstractPDVFile) pairs from a container.
function _collect_file_nodes(value, tree_path::String,
                             out::Vector{Tuple{String,AbstractPDVFile}})
    if value isa AbstractPDVFile
        push!(out, (tree_path, value))
        return nothing
    end
    if value isa AbstractPDVTree
        for key in collect(keys(value.data))
            child_path = isempty(tree_path) ? key : "$tree_path.$key"
            _collect_file_nodes(value.data[key], child_path, out)
        end
    elseif value isa AbstractDict
        for key in collect(keys(value))
            child_path = isempty(tree_path) ? string(key) : "$tree_path.$(key)"
            _collect_file_nodes(value[key], child_path, out)
        end
    end
    nothing
end

# Extract the <uuid> segment from a path under a tree/ directory.
function _extract_uuid_segment(abs_path::String)
    parts = splitpath(normpath(abs_path))
    for (index, part) in enumerate(parts)
        if part == "tree" && index + 1 <= length(parts)
            candidate = parts[index+1]
            isempty(candidate) || return candidate
        end
    end
    return nothing
end

"""
    handle_resolve_path(msg)

Handle `pdv.tree.resolve_path`: bidirectional translation between a
dot-delimited tree path and an absolute filesystem path.
"""
function handle_resolve_path(msg::AbstractDict)
    msg_id = get(msg, "msg_id", nothing)
    validated = validate_register_request(msg, "pdv.tree.resolve_path.response",
                                          "introspection"; required_fields=("path",))
    validated === nothing && return nothing
    tree, payload = validated
    path = string(get(payload, "path", ""))
    working_dir = tree.working_dir

    if isabspath(path)
        # Reverse: filesystem path -> tree path(s).
        target_real = ispath(path) ? realpath(path) : normpath(path)
        target_uuid = _extract_uuid_segment(target_real)

        file_nodes = Tuple{String,AbstractPDVFile}[]
        _collect_file_nodes(tree, "", file_nodes)

        tree_paths = String[]
        for (node_path, node) in file_nodes
            matched = target_uuid !== nothing && node.uuid == target_uuid
            if !matched && working_dir !== nothing
                node_real = try
                    p = resolve_path(node, working_dir)
                    ispath(p) ? realpath(p) : normpath(p)
                catch
                    nothing
                end
                matched = node_real !== nothing && node_real == target_real
            end
            matched && push!(tree_paths, node_path)
        end

        send_message("pdv.tree.resolve_path.response", Dict{String,Any}(
            "input" => path, "tree_paths" => tree_paths, "file_path" => target_real);
            in_reply_to=msg_id)
        return nothing
    end

    # Forward: tree path -> filesystem path.
    if !haskey(tree, path)
        send_error("pdv.tree.resolve_path.response", "tree.path_not_found",
                   "No node at tree path: '$path'"; in_reply_to=msg_id)
        return nothing
    end
    node = tree[path]
    file_path = nothing
    if node isa AbstractPDVFile
        file_path = try
            resolve_path(node, working_dir)
        catch
            nothing
        end
    end

    send_message("pdv.tree.resolve_path.response", Dict{String,Any}(
        "input" => path, "tree_paths" => [path], "file_path" => file_path);
        in_reply_to=msg_id)
    nothing
end

register_message_handler("pdv.help", handle_help)
register_message_handler("pdv.tree.resolve_path", handle_resolve_path)
