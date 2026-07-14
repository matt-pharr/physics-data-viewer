# namelist_utils.jl — Namelist file parsing and writing utilities.
#
# Port of pdv/namelist_utils.py. Pure utility file with no dependency on
# comms or handlers.
#
# Supports:
# - Fortran namelists (.in, .nml) via a built-in parser covering the common
#   subset (groups, scalars, arrays, strings, logicals, repeat counts,
#   D-exponents, comments, line continuation). Julia has no f90nml analog,
#   so PDV ships its own.
# - TOML files (.toml) via the TOML stdlib (read and write).

"""
    detect_namelist_format(file_path) -> String

Detect namelist format from file extension: `"fortran"` for `.in`/`.nml`,
`"toml"` for `.toml`. Throws `ArgumentError` otherwise.
"""
function detect_namelist_format(file_path::AbstractString)::String
    ext = lowercase(splitext(file_path)[2])
    ext in (".in", ".nml") && return "fortran"
    ext == ".toml" && return "toml"
    throw(ArgumentError("Cannot detect namelist format for extension '$ext'"))
end

"""
    read_namelist(file_path; format="auto") -> Dict

Parse a namelist file into `{group_name => {key => value}}`.
"""
function read_namelist(file_path::AbstractString; format::AbstractString="auto")
    fmt = format == "auto" ? detect_namelist_format(file_path) : String(format)
    fmt == "fortran" && return _read_fortran(file_path)
    fmt == "toml" && return _sanitize_toml(TOML.parsefile(file_path))
    throw(ArgumentError("Unsupported namelist format: '$fmt'"))
end

# TOML.parsefile returns Dict{String,Any} already; normalize nested Dicts.
_sanitize_toml(x) = x

"""
    write_namelist(file_path, data; format="auto")

Write `{group => {key => value}}` structured data to a namelist file.
"""
function write_namelist(file_path::AbstractString, data::AbstractDict;
                        format::AbstractString="auto")
    fmt = format == "auto" ? detect_namelist_format(file_path) : String(format)
    if fmt == "fortran"
        _write_fortran(file_path, data)
    elseif fmt == "toml"
        open(file_path, "w") do io
            TOML.print(io, _toml_ready(data))
        end
    else
        throw(ArgumentError("Unsupported namelist format: '$fmt'"))
    end
    nothing
end

# TOML.print requires Dict{String,...} with TOML-representable values.
function _toml_ready(x::AbstractDict)
    return Dict{String,Any}(string(k) => _toml_ready(v) for (k, v) in pairs(x))
end
_toml_ready(x::AbstractVector) = Any[_toml_ready(v) for v in x]
_toml_ready(x) = x

"""
    infer_types(data) -> Dict

Infer value types for renderer field selection:
`{group => {key => "int"|"float"|"bool"|"str"|"array"}}`.
"""
function infer_types(data::AbstractDict)::Dict{String,Any}
    result = Dict{String,Any}()
    for (group, entries) in pairs(data)
        entries isa AbstractDict || continue
        group_types = Dict{String,Any}()
        for (key, value) in pairs(entries)
            group_types[string(key)] = _infer_single_type(value)
        end
        result[string(group)] = group_types
    end
    return result
end

function _infer_single_type(value)::String
    value isa Bool && return "bool"
    value isa Integer && return "int"
    value isa AbstractFloat && return "float"
    value isa AbstractString && return "str"
    (value isa AbstractVector || value isa Tuple) && return "array"
    return "str"
end

"""
    extract_hints(file_path; format="auto") -> Dict

Extract comment hints adjacent to keys: `{group => {key => hint}}`.
Fortran uses `!` comments; TOML uses `#`.
"""
function extract_hints(file_path::AbstractString; format::AbstractString="auto")
    fmt = format == "auto" ? detect_namelist_format(file_path) : String(format)
    lines = try
        readlines(file_path)
    catch
        return Dict{String,Any}()
    end
    fmt == "fortran" && return _extract_hints(lines;
        group_re=r"^\s*&(\w+)", key_re=r"^\s*(\w[\w%]*)(\([^)]*\))?\s*=",
        inline_re=r"!\s*(.*?)\s*$", comment_re=r"^\s*!\s*(.*?)\s*$",
        group_end=line -> startswith(strip(line), "/"))
    fmt == "toml" && return _extract_hints(lines;
        group_re=r"^\s*\[([^\]]+)\]", key_re=r"^\s*(\w[\w.-]*)\s*=",
        inline_re=r"#\s*(.*?)\s*$", comment_re=r"^\s*#\s*(.*?)\s*$",
        group_end=_ -> false, default_group="_root")
    return Dict{String,Any}()
end

function _extract_hints(lines::Vector{String}; group_re, key_re, inline_re,
                        comment_re, group_end, default_group::Union{Nothing,String}=nothing)
    hints = Dict{String,Any}()
    current_group::Union{Nothing,String} = nothing
    prev_comment::Union{Nothing,String} = nothing

    for line in lines
        gm = match(group_re, line)
        if gm !== nothing
            current_group = strip(gm.captures[1])
            haskey(hints, current_group) || (hints[current_group] = Dict{String,Any}())
            prev_comment = nothing
            continue
        end
        cm = match(comment_re, line)
        if cm !== nothing
            prev_comment = cm.captures[1]
            continue
        end
        km = match(key_re, line)
        if km !== nothing && (current_group !== nothing || default_group !== nothing)
            group = current_group === nothing ? default_group : current_group
            haskey(hints, group) || (hints[group] = Dict{String,Any}())
            key = km.captures[1]
            im = match(inline_re, line)
            if im !== nothing
                hints[group][key] = im.captures[1]
            elseif prev_comment !== nothing
                hints[group][key] = prev_comment
            end
            prev_comment = nothing
            continue
        end
        if group_end(line)
            current_group = nothing
        end
        prev_comment = nothing
    end
    return hints
end

# ---------------------------------------------------------------------------
# Fortran namelist parser
# ---------------------------------------------------------------------------

# Strip a trailing ! comment that is not inside a quoted string.
function _strip_fortran_comment(line::AbstractString)::String
    in_single = false
    in_double = false
    for (i, c) in pairs(line)
        if c == '\'' && !in_double
            in_single = !in_single
        elseif c == '"' && !in_single
            in_double = !in_double
        elseif c == '!' && !in_single && !in_double
            return String(line[1:prevind(line, i)])
        end
    end
    return String(line)
end

# Parse one Fortran scalar token into a Julia value.
function _parse_fortran_value(token::AbstractString)
    t = strip(token)
    isempty(t) && return nothing
    # Strings
    if (startswith(t, "'") && endswith(t, "'") && length(t) >= 2)
        return replace(t[2:end-1], "''" => "'")
    end
    if (startswith(t, "\"") && endswith(t, "\"") && length(t) >= 2)
        return replace(t[2:end-1], "\"\"" => "\"")
    end
    # Logicals
    tl = lowercase(t)
    tl in (".true.", "t", ".t.", "true") && return true
    tl in (".false.", "f", ".f.", "false") && return false
    # Integers
    i = tryparse(Int, t)
    i !== nothing && return i
    # Reals (Fortran D exponents)
    f = tryparse(Float64, replace(tl, "d" => "e"))
    f !== nothing && return f
    return String(t)
end

# Split a value payload on commas that are outside quotes.
function _split_fortran_values(payload::AbstractString)::Vector{String}
    parts = String[]
    buf = IOBuffer()
    in_single = false
    in_double = false
    for c in payload
        if c == '\'' && !in_double
            in_single = !in_single
            write(buf, c)
        elseif c == '"' && !in_single
            in_double = !in_double
            write(buf, c)
        elseif c == ',' && !in_single && !in_double
            push!(parts, String(take!(buf)))
        else
            write(buf, c)
        end
    end
    push!(parts, String(take!(buf)))
    return parts
end

# Expand `n*value` repeat syntax and parse each token.
function _parse_fortran_payload(payload::AbstractString)
    values = Any[]
    for raw in _split_fortran_values(payload)
        t = strip(raw)
        isempty(t) && continue
        m = match(r"^(\d+)\s*\*\s*(.+)$", t)
        if m !== nothing
            count = parse(Int, m.captures[1])
            v = _parse_fortran_value(m.captures[2])
            append!(values, fill(v, count))
        else
            push!(values, _parse_fortran_value(t))
        end
    end
    isempty(values) && return nothing
    length(values) == 1 && return values[1]
    return values
end

function _read_fortran(file_path::AbstractString)::Dict{String,Any}
    groups = Dict{String,Any}()
    current_group::Union{Nothing,String} = nothing
    current_key::Union{Nothing,String} = nothing

    for raw_line in readlines(file_path)
        line = strip(_strip_fortran_comment(raw_line))
        isempty(line) && continue

        gm = match(r"^&(\w+)", line)
        if gm !== nothing
            current_group = lowercase(gm.captures[1])
            haskey(groups, current_group) || (groups[current_group] = Dict{String,Any}())
            current_key = nothing
            continue
        end
        if startswith(line, "/") || lowercase(line) == "&end"
            current_group = nothing
            current_key = nothing
            continue
        end
        current_group === nothing && continue

        km = match(r"^(\w[\w%]*)\s*(\(([^)]*)\))?\s*=\s*(.*)$", line)
        if km !== nothing
            key = lowercase(km.captures[1])
            index_expr = km.captures[3]
            payload = km.captures[4]
            value = _parse_fortran_payload(payload)
            group = groups[current_group]
            if index_expr !== nothing
                idx = tryparse(Int, strip(index_expr))
                if idx !== nothing
                    arr = get!(group, key, Any[])
                    arr isa AbstractVector || (arr = Any[arr]; group[key] = arr)
                    while length(arr) < idx
                        push!(arr, nothing)
                    end
                    arr[idx] = value
                else
                    group[key] = value  # complex index expression: last write wins
                end
            else
                group[key] = value
            end
            current_key = key
            continue
        end

        # Continuation line: extra values for the previous key.
        if current_key !== nothing
            extra = _parse_fortran_payload(line)
            extra === nothing && continue
            group = groups[current_group]
            existing = get(group, current_key, nothing)
            base = existing isa AbstractVector ? existing : Any[existing]
            extra_vec = extra isa AbstractVector ? extra : Any[extra]
            group[current_key] = vcat(base, extra_vec)
        end
    end
    return groups
end

# Format a Julia value as a Fortran namelist literal.
function _format_fortran_value(value)::String
    value isa Bool && return value ? ".true." : ".false."
    value isa Integer && return string(value)
    value isa AbstractFloat && return string(Float64(value))
    value === nothing && return ""
    if value isa AbstractString
        return "'" * replace(String(value), "'" => "''") * "'"
    end
    if value isa AbstractVector || value isa Tuple
        return join((_format_fortran_value(v) for v in value), ", ")
    end
    return "'" * string(value) * "'"
end

function _write_fortran(file_path::AbstractString, data::AbstractDict)
    open(file_path, "w") do io
        for (group, entries) in pairs(data)
            entries isa AbstractDict || continue
            println(io, "&", group)
            for (key, value) in pairs(entries)
                println(io, "    ", key, " = ", _format_fortran_value(value))
            end
            println(io, "/")
            println(io)
        end
    end
    nothing
end
