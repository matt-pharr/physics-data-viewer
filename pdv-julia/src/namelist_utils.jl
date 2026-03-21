# PDVKernel namelist_utils — Namelist file parsing and writing utilities.
#
# Supports:
# - Fortran namelists (.in, .nml) via simple parser (no external dependency)
# - TOML files (.toml) via TOML stdlib

"""
    detect_namelist_format(file_path::String) -> String

Detect namelist format from file extension.
"""
function detect_namelist_format(file_path::String)::String
    ext = lowercase(splitext(file_path)[2])
    if ext in (".in", ".nml")
        return "fortran"
    end
    if ext == ".toml"
        return "toml"
    end
    throw(ArgumentError("Cannot detect namelist format for extension '$ext'"))
end

"""
    read_namelist(file_path::String; format::String="auto") -> Dict

Parse a namelist file and return structured data.
"""
function read_namelist(file_path::String; format::String="auto")::Dict{String,Any}
    if format == "auto"
        format = detect_namelist_format(file_path)
    end
    if format == "fortran"
        return _read_fortran(file_path)
    end
    if format == "toml"
        return _read_toml(file_path)
    end
    throw(ArgumentError("Unsupported namelist format: '$format'"))
end

"""
    write_namelist(file_path::String, data::Dict; format::String="auto")

Write structured data to a namelist file.
"""
function write_namelist(file_path::String, data::Dict; format::String="auto")
    if format == "auto"
        format = detect_namelist_format(file_path)
    end
    if format == "fortran"
        _write_fortran(file_path, data)
    elseif format == "toml"
        _write_toml(file_path, data)
    else
        throw(ArgumentError("Unsupported namelist format: '$format'"))
    end
end

"""
    extract_hints(file_path::String; format::String="auto") -> Dict

Extract comment hints adjacent to keys in a namelist file.
"""
function extract_hints(file_path::String; format::String="auto")::Dict{String,Any}
    if format == "auto"
        format = detect_namelist_format(file_path)
    end
    lines = try
        readlines(file_path)
    catch
        return Dict{String,Any}()
    end
    if format == "fortran"
        return _extract_hints_fortran(lines)
    end
    if format == "toml"
        return _extract_hints_toml(lines)
    end
    return Dict{String,Any}()
end

"""
    infer_types(data::Dict) -> Dict

Infer value types for renderer field selection.
"""
function infer_types(data::Dict)::Dict{String,Any}
    result = Dict{String,Any}()
    for (group, entries) in data
        if !(entries isa Dict)
            continue
        end
        group_types = Dict{String,String}()
        for (key, value) in entries
            group_types[key] = _infer_single_type(value)
        end
        result[group] = group_types
    end
    return result
end

# ---------------------------------------------------------------------------
# Fortran namelist parser (simple, no f90nml dependency)
# ---------------------------------------------------------------------------

function _read_fortran(file_path::String)::Dict{String,Any}
    result = Dict{String,Any}()
    current_group = nothing
    current_entries = Dict{String,Any}()

    for line in eachline(file_path)
        stripped = strip(line)

        # Skip empty lines and pure comment lines
        if isempty(stripped)
            continue
        end

        # Group header: &group_name
        m = match(r"^\s*&(\w+)", stripped)
        if m !== nothing
            current_group = m.captures[1]
            current_entries = Dict{String,Any}()
            continue
        end

        # End of group: /
        if stripped == "/" || startswith(stripped, "/")
            if current_group !== nothing
                result[current_group] = current_entries
                current_group = nothing
                current_entries = Dict{String,Any}()
            end
            continue
        end

        # Skip comment-only lines
        if startswith(stripped, "!")
            continue
        end

        # Key = value (possibly with inline comment)
        if current_group !== nothing
            # Remove inline comments
            no_comment = replace(stripped, r"!.*$" => "")
            km = match(r"^\s*(\w[\w%]*)\s*=\s*(.*)", no_comment)
            if km !== nothing
                key = km.captures[1]
                val_str = strip(rstrip(km.captures[2], ','))
                current_entries[key] = _parse_fortran_value(val_str)
            end
        end
    end

    return result
end

function _parse_fortran_value(val_str::AbstractString)
    s = strip(val_str)
    if isempty(s)
        return ""
    end

    # Boolean
    if s in (".true.", ".TRUE.", "T", "t")
        return true
    end
    if s in (".false.", ".FALSE.", "F", "f")
        return false
    end

    # Quoted string
    if (startswith(s, "'") && endswith(s, "'")) || (startswith(s, "\"") && endswith(s, "\""))
        return s[2:end-1]
    end

    # Array (comma-separated)
    if occursin(",", s)
        parts = split(s, ",")
        return [_parse_fortran_value(strip(String(p))) for p in parts if !isempty(strip(p))]
    end

    # Integer
    int_val = tryparse(Int, s)
    if int_val !== nothing
        return int_val
    end

    # Float (handle Fortran d/D exponent notation)
    s_float = replace(replace(s, r"[dD]" => "e"), r"[dD]" => "e")
    float_val = tryparse(Float64, s_float)
    if float_val !== nothing
        return float_val
    end

    return s
end

function _write_fortran(file_path::String, data::Dict)
    open(file_path, "w") do io
        for (group, entries) in data
            println(io, "&$group")
            if entries isa Dict
                for (key, value) in entries
                    println(io, "  $key = $(_format_fortran_value(value)),")
                end
            end
            println(io, "/")
            println(io)
        end
    end
end

function _format_fortran_value(value)::String
    if value isa Bool
        return value ? ".true." : ".false."
    end
    if value isa AbstractString
        return "'$value'"
    end
    if value isa AbstractVector
        return join([_format_fortran_value(v) for v in value], ", ")
    end
    return string(value)
end

# ---------------------------------------------------------------------------
# TOML reader/writer
# ---------------------------------------------------------------------------

function _read_toml(file_path::String)::Dict{String,Any}
    # Use TOML stdlib (available since Julia 1.6)
    toml_mod = Base.require(Main, :TOML)
    return toml_mod.parsefile(file_path)
end

function _write_toml(file_path::String, data::Dict)
    toml_mod = Base.require(Main, :TOML)
    open(file_path, "w") do io
        toml_mod.print(io, data)
    end
end

# ---------------------------------------------------------------------------
# Comment hint extraction
# ---------------------------------------------------------------------------

function _extract_hints_fortran(lines::Vector{String})::Dict{String,Any}
    hints = Dict{String,Any}()
    current_group = nothing
    prev_comment = nothing

    for line in lines
        # Group header
        m = match(r"^\s*&(\w+)", line)
        if m !== nothing
            current_group = m.captures[1]
            if !haskey(hints, current_group)
                hints[current_group] = Dict{String,String}()
            end
            prev_comment = nothing
            continue
        end

        # Standalone comment
        cm = match(r"^\s*!\s*(.*?)\s*$", line)
        if cm !== nothing
            prev_comment = cm.captures[1]
            continue
        end

        # Key assignment
        km = match(r"^\s*(\w[\w%]*)\s*=", line)
        if km !== nothing && current_group !== nothing
            key = km.captures[1]
            # Inline comment
            im = match(r"!\s*(.*?)\s*$", line)
            if im !== nothing
                hints[current_group][key] = im.captures[1]
            elseif prev_comment !== nothing
                hints[current_group][key] = prev_comment
            end
            prev_comment = nothing
            continue
        end

        # End of group
        if strip(line) == "/" || startswith(strip(line), "/")
            current_group = nothing
            prev_comment = nothing
            continue
        end

        prev_comment = nothing
    end

    return hints
end

function _extract_hints_toml(lines::Vector{String})::Dict{String,Any}
    hints = Dict{String,Any}()
    current_group = nothing
    prev_comment = nothing

    for line in lines
        # Section header
        sm = match(r"^\s*\[([^\]]+)\]", line)
        if sm !== nothing
            current_group = strip(sm.captures[1])
            if !haskey(hints, current_group)
                hints[current_group] = Dict{String,String}()
            end
            prev_comment = nothing
            continue
        end

        # Standalone comment
        cm = match(r"^\s*#\s*(.*?)\s*$", line)
        if cm !== nothing
            prev_comment = cm.captures[1]
            continue
        end

        # Key assignment
        km = match(r"^\s*(\w[\w.-]*)\s*=", line)
        if km !== nothing
            key = km.captures[1]
            group = something(current_group, "_root")
            if !haskey(hints, group)
                hints[group] = Dict{String,String}()
            end
            im = match(r"#\s*(.*?)\s*$", line)
            if im !== nothing
                hints[group][key] = im.captures[1]
            elseif prev_comment !== nothing
                hints[group][key] = prev_comment
            end
            prev_comment = nothing
            continue
        end

        prev_comment = nothing
    end

    return hints
end

function _infer_single_type(value)::String
    if value isa Bool
        return "bool"
    end
    if value isa Integer
        return "int"
    end
    if value isa AbstractFloat
        return "float"
    end
    if value isa AbstractString
        return "str"
    end
    if value isa Union{AbstractVector,Tuple}
        return "array"
    end
    return "str"
end
