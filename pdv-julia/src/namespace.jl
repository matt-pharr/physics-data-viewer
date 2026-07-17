# namespace.jl — Kernel namespace snapshot and lazy inspection.
#
# Port of pdv/namespace.py. On a Julia kernel the "user namespace" is the
# set of global bindings in `Main`. Protection of `pdv_tree` is achieved by
# declaring it `const` in `Main` at bootstrap — Julia itself then rejects
# reassignment, which replaces Python's PDVNamespace dict subclass.

const PROTECTED_NAMES = Set(["pdv_tree"])

# Bindings that exist in every Main but are never user variables.
const _NAMESPACE_NOISE = Set(["Main", "Base", "Core", "ans", "err", "Out", "In",
                              "IJulia", "PDVKernel"])

"""
    namespace_bindings() -> Dict{String,Any}

Snapshot the current global bindings of `Main` as a name → value Dict.
"""
function namespace_bindings()::Dict{String,Any}
    ns = Dict{String,Any}()
    for sym in names(Main; all=true, imported=false)
        s = string(sym)
        # Only compiler gensyms are dropped here. User `_`-prefixed bindings
        # stay in the snapshot so `pdv_namespace`'s `include_private` option
        # actually has something to include (matching pdv-python, where the
        # private filter lives solely in the presentation layer).
        startswith(s, "#") && continue
        s in _NAMESPACE_NOISE && continue
        isdefined(Main, sym) || continue
        ns[s] = getfield(Main, sym)
    end
    return ns
end

"""
    pdv_namespace(ns; include_private=false, include_modules=false,
                  include_callables=false) -> Dict

Return a snapshot of the kernel namespace for the Namespace panel, excluding
PDV internals. Mirrors the Python filter semantics.
"""
function pdv_namespace(ns::AbstractDict;
                       include_private::Bool=false,
                       include_modules::Bool=false,
                       include_callables::Bool=false)::Dict{String,Any}
    result = Dict{String,Any}()
    for (name, value) in ns
        name in PROTECTED_NAMES && continue
        startswith(name, "_pdv") && continue
        (!include_private && startswith(name, "_")) && continue
        (!include_modules && value isa Module) && continue
        (!include_callables && value isa Function) && continue
        result[name] = describe_namespace_value(value; name=name, path=Any[],
                                                expression=name)
    end
    return result
end

"""
    inspect_namespace(ns; root_name, path=[], max_children=50) -> Dict

Inspect one namespace value and return one level of child descriptors.
"""
function inspect_namespace(ns::AbstractDict; root_name::AbstractString,
                           path::Union{Nothing,AbstractVector}=nothing,
                           max_children::Int=50)::Dict{String,Any}
    selectors = path === nothing ? Any[] : collect(Any, path)
    value = resolve_namespace_target(ns; root_name=root_name, path=selectors)
    children, total_children = describe_namespace_children(
        value; path=selectors,
        expression=build_namespace_expression(root_name, selectors),
        max_children=max_children)
    payload = Dict{String,Any}(
        "children" => children,
        "truncated" => total_children > length(children),
    )
    total_children >= 0 && (payload["total_children"] = total_children)
    return payload
end

# ---------------------------------------------------------------------------
# Descriptors
# ---------------------------------------------------------------------------

safe_repr(value) = try
    repr(value)
catch
    "<unrepresentable>"
end

function trim_preview(text::AbstractString; max_length::Int=120)::String
    length(text) <= max_length && return String(text)
    return first(text, max_length - 3) * "..."
end

"""Return a stable public-field mapping for object inspection."""
function iter_object_attributes(value)::Vector{Pair{String,Any}}
    T = typeof(value)
    (isprimitivetype(T) || T <: Function || value isa Module || value isa Type) &&
        return Pair{String,Any}[]
    attrs = Pair{String,Any}[]
    try
        for f in fieldnames(T)
            s = string(f)
            startswith(s, "_") && continue
            isdefined(value, f) || continue
            push!(attrs, s => getfield(value, f))
        end
    catch
    end
    return attrs
end

value_has_object_children(value) = !isempty(iter_object_attributes(value))

"""Return the canonical namespace inspector kind for a value."""
function namespace_kind(value)::String
    kind = detect_kind(value)
    if kind == KIND_UNKNOWN && value_has_object_children(value)
        return "object"
    end
    return kind
end

"""Return a rich but bounded preview string for a namespace value."""
function namespace_preview(value; max_length::Int=120)::String
    kind = namespace_kind(value)
    try
        if kind == KIND_NDARRAY
            body = sprint(show, value; context=(:limit => true, :compact => true))
            return trim_preview(body; max_length=max_length)
        elseif kind == KIND_DATAFRAME
            mod = loaded_module(:DataFrames)
            cols = string.(Base.invokelatest(getproperty(mod, :names), value))
            shown = join(first(cols, 3), ", ")
            more = length(cols) > 3 ? ", ..." : ""
            r, c = size(value)
            return trim_preview("DataFrame[$r x $c] columns=[$shown$more]";
                                max_length=max_length)
        elseif kind in (KIND_MAPPING, KIND_SEQUENCE, KIND_TEXT)
            return trim_preview(safe_repr(value); max_length=max_length)
        elseif kind == KIND_BINARY
            return "bytes ($(length(value)) bytes)"
        elseif kind == "object"
            attrs = first.(iter_object_attributes(value))
            summary = string(nameof(typeof(value)), "(", join(first(attrs, 3), ", "),
                             length(attrs) > 3 ? ", ..." : "", ")")
            return trim_preview(summary; max_length=max_length)
        end
    catch
    end
    return trim_preview(safe_repr(value); max_length=max_length)
end

"""Return child count for expandable values, or 0 for leaves."""
function namespace_child_count(value)::Int
    kind = namespace_kind(value)
    try
        if kind in (KIND_MAPPING, KIND_SEQUENCE, KIND_TEXT, KIND_BINARY)
            return length(value)
        elseif kind == KIND_NDARRAY
            ndims(value) == 0 && return 0
            return size(value, 1)
        elseif kind == KIND_DATAFRAME
            return size(value, 2)
        elseif kind == "object"
            return length(iter_object_attributes(value))
        end
    catch
    end
    return 0
end

"""Build a renderer-facing descriptor for one namespace value."""
function describe_namespace_value(value; name::AbstractString,
                                  path::AbstractVector, expression::AbstractString)
    kind = namespace_kind(value)
    descriptor = Dict{String,Any}(
        "name" => name,
        "kind" => kind,
        "type" => string(typeof(value)),
        "preview" => namespace_preview(value),
        "path" => path,
        "expression" => expression,
    )
    if kind == KIND_NDARRAY
        descriptor["shape"] = collect(size(value))
        descriptor["dtype"] = _dtype_name(eltype(value))
        descriptor["size"] = sizeof(value)
    elseif kind == KIND_DATAFRAME
        descriptor["shape"] = collect(size(value))
    end
    if value isa Union{AbstractVector,Tuple,AbstractDict,AbstractString,AbstractSet}
        try
            descriptor["length"] = length(value)
        catch
        end
    end
    child_count = namespace_child_count(value)
    descriptor["has_children"] = child_count > 0
    child_count >= 0 && (descriptor["child_count"] = child_count)
    return descriptor
end

"""Build a user-facing expression string from a selector path."""
function build_namespace_expression(root_name::AbstractString,
                                    path::AbstractVector)::String
    expression = String(root_name)
    for segment in path
        kind = get(segment, "kind", "")
        value = get(segment, "value", nothing)
        if kind == "attr"
            expression *= "." * string(value)
        else
            expression *= "[" * (value isa AbstractString ? repr(String(value)) : string(value)) * "]"
        end
    end
    return expression
end

"""Resolve a lazy-inspection target inside the namespace."""
function resolve_namespace_target(ns::AbstractDict; root_name::AbstractString,
                                  path::AbstractVector)
    haskey(ns, root_name) || throw(KeyError("Namespace variable not found: $root_name"))
    value = ns[root_name]
    for segment in path
        kind = get(segment, "kind", "")
        raw = get(segment, "value", nothing)
        if kind == "attr"
            value = getfield(value, Symbol(string(raw)))
        elseif kind == "column"
            value = value[!, Symbol(string(raw))]
        elseif kind == "index"
            value = value isa AbstractArray && ndims(value) > 1 ?
                selectdim(value, 1, Int(raw)) : value[Int(raw)]
        elseif kind == "key"
            value = _namespace_key_lookup(value, raw)
        else
            throw(KeyError("Unsupported namespace selector kind: $kind"))
        end
    end
    return value
end

# Dict keys sent over the wire lose their Julia type (Symbol → String, etc).
# Try the raw value first, then a few faithful coercions.
function _namespace_key_lookup(dict, raw)
    # NamedTuples only accept Symbol/Int keys — haskey(nt, ::String) throws.
    dict isa NamedTuple && raw isa AbstractString && return dict[Symbol(raw)]
    haskey(dict, raw) && return dict[raw]
    if raw isa AbstractString
        sym = Symbol(raw)
        haskey(dict, sym) && return dict[sym]
        i = tryparse(Int, raw)
        i !== nothing && haskey(dict, i) && return dict[i]
    end
    if raw isa Real
        haskey(dict, Int(raw)) && return dict[Int(raw)]
    end
    return dict[raw]  # throws the natural KeyError
end

# JSON-safe selector value, with support flag.
function primitive_namespace_value(value)
    (value === nothing || value isa AbstractString || value isa Real || value isa Bool) &&
        return (true, value)
    value isa Symbol && return (true, string(value))
    return (false, safe_repr(value))
end

"""Describe one level of children for an expandable namespace value."""
function describe_namespace_children(value; path::AbstractVector,
                                     expression::AbstractString, max_children::Int)
    kind = namespace_kind(value)
    children = Dict{String,Any}[]

    if kind == KIND_MAPPING
        ks = collect(keys(value))
        for key in first(ks, max_children)
            is_supported, segment_value = primitive_namespace_value(key)
            child_path = vcat(path, Any[Dict{String,Any}("kind" => "key", "value" => segment_value)])
            descriptor = describe_namespace_value(
                value[key]; name=safe_repr(key), path=child_path,
                expression="$expression[$(safe_repr(key))]")
            if !is_supported
                descriptor["has_children"] = false
                descriptor["child_count"] = 0
                descriptor["preview"] = trim_preview(
                    string(get(descriptor, "preview", "<unknown>"), " (non-serializable key)"))
            end
            push!(children, descriptor)
        end
        return children, length(ks)

    elseif kind == KIND_SEQUENCE || (kind == KIND_NDARRAY && ndims(value) == 1)
        total = length(value)
        items = value isa AbstractSet ? collect(value) : value
        for index in 1:min(total, max_children)
            child = items isa Tuple ? items[index] : items[firstindex(items) + index - 1]
            child_path = vcat(path, Any[Dict{String,Any}("kind" => "index", "value" => index)])
            push!(children, describe_namespace_value(
                child; name="[$index]", path=child_path,
                expression="$expression[$index]"))
        end
        return children, total

    elseif kind == KIND_NDARRAY
        total = size(value, 1)
        for index in 1:min(total, max_children)
            child = selectdim(value, 1, index)
            child_path = vcat(path, Any[Dict{String,Any}("kind" => "index", "value" => index)])
            push!(children, describe_namespace_value(
                collect(child); name="[$index]", path=child_path,
                expression="$expression[$index, :]"))
        end
        return children, total

    elseif kind == KIND_DATAFRAME
        mod = loaded_module(:DataFrames)
        cols = Base.invokelatest(getproperty(mod, :names), value)
        for col in first(cols, max_children)
            child = value[!, col]
            child_path = vcat(path, Any[Dict{String,Any}("kind" => "column", "value" => string(col))])
            push!(children, describe_namespace_value(
                child; name=string(col), path=child_path,
                expression="$expression[!, :$(col)]"))
        end
        return children, length(cols)

    elseif kind == "object"
        attrs = iter_object_attributes(value)
        for (attr_name, attr_value) in first(attrs, max_children)
            child_path = vcat(path, Any[Dict{String,Any}("kind" => "attr", "value" => attr_name)])
            push!(children, describe_namespace_value(
                attr_value; name=attr_name, path=child_path,
                expression="$expression.$attr_name"))
        end
        return children, length(attrs)
    end

    return children, 0
end
