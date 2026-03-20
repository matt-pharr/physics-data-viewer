# PDVKernel serialization — Type detection and format readers/writers.
#
# Handles conversion between in-memory Julia values and on-disk file representations.
#
# Supported formats:
# - jld2 — Julia arrays and general types (requires JLD2.jl)
# - arrow — DataFrames (requires Arrow.jl)
# - json — JSON-native scalars, dicts, vectors
# - txt — Plain text strings
# - julia_serialize — Fallback for unknown types (Serialization stdlib)

# Node kind strings — must match ARCHITECTURE.md §7.2
const KIND_FOLDER = "folder"
const KIND_SCRIPT = "script"
const KIND_NDARRAY = "ndarray"
const KIND_DATAFRAME = "dataframe"
const KIND_SCALAR = "scalar"
const KIND_TEXT = "text"
const KIND_MAPPING = "mapping"
const KIND_SEQUENCE = "sequence"
const KIND_MARKDOWN = "markdown"
const KIND_BINARY = "binary"
const KIND_MODULE = "module"
const KIND_GUI = "gui"
const KIND_NAMELIST = "namelist"
const KIND_LIB = "lib"
const KIND_FILE = "file"
const KIND_HDF5 = "hdf5"
const KIND_UNKNOWN = "unknown"

# Format strings — must match ARCHITECTURE.md §7.3 storage.format
const FORMAT_JLD2 = "jld2"
const FORMAT_ARROW = "arrow"
const FORMAT_JSON = "json"
const FORMAT_TXT = "txt"
const FORMAT_JULIA_SERIALIZE = "julia_serialize"
const FORMAT_JL_SCRIPT = "jl_script"
const FORMAT_MARKDOWN = "markdown"
const FORMAT_INLINE = "inline"
const FORMAT_GUI_JSON = "gui_json"
const FORMAT_MODULE_META = "module_meta"
const FORMAT_NAMELIST = "namelist"
const FORMAT_JL_LIB = "jl_lib"

"""
    julia_type_string(value) -> String

Return the fully qualified type string for any value.
"""
julia_type_string(value) = string(typeof(value))

"""
    detect_kind(value) -> String

Detect the node kind for a Julia value.
"""
function detect_kind(value)::String
    if value isa PDVModule
        return KIND_MODULE
    end
    if value isa PDVTree
        return KIND_FOLDER
    end
    if value isa PDVFile
        if value isa PDVScript
            return KIND_SCRIPT
        end
        if value isa PDVNote
            return KIND_MARKDOWN
        end
        if value isa PDVGui
            return KIND_GUI
        end
        if value isa PDVNamelist
            return KIND_NAMELIST
        end
        if value isa PDVLib
            return KIND_LIB
        end
        if value isa PDVHDF5
            return KIND_HDF5
        end
        return KIND_FILE
    end
    if value isa Bool
        return KIND_SCALAR
    end
    if value isa Number || value === nothing
        return KIND_SCALAR
    end
    if value isa AbstractString
        return KIND_TEXT
    end
    if value isa AbstractVector{UInt8}
        return KIND_BINARY
    end
    if value isa AbstractDict
        return KIND_MAPPING
    end
    if value isa Union{AbstractVector,Tuple}
        return KIND_SEQUENCE
    end
    if value isa AbstractArray
        return KIND_NDARRAY
    end
    # Check for DataFrame via duck-typing (avoid hard dependency)
    if _is_dataframe(value)
        return KIND_DATAFRAME
    end
    return KIND_UNKNOWN
end

function _is_dataframe(value)::Bool
    T = typeof(value)
    tn = string(T)
    return occursin("DataFrame", tn)
end

"""
    serialize_node(tree_path, value, working_dir; trusted=false, source_dir="") -> Dict

Serialize a value to disk and return a node descriptor dict.
"""
function serialize_node(tree_path::String, value, working_dir::String;
                        trusted::Bool=false, source_dir::String="")::Dict{String,Any}
    using_source_dir = isempty(source_dir) ? working_dir : source_dir

    kind = detect_kind(value)
    now = Dates.format(Dates.now(Dates.UTC), "yyyy-mm-ddTHH:MM:SS") * "Z"
    parts = split(tree_path, ".")
    key = String(parts[end])
    parent_path = length(parts) > 1 ? join(parts[1:end-1], ".") : ""

    # Base descriptor
    descriptor = Dict{String,Any}(
        "id" => tree_path,
        "path" => tree_path,
        "key" => key,
        "parent_path" => parent_path,
        "type" => kind,
        "has_children" => false,
        "lazy" => false,
        "created_at" => now,
        "updated_at" => now,
    )

    preview = node_preview(value, kind)

    if kind == KIND_FOLDER
        descriptor["has_children"] = true
        descriptor["storage"] = Dict{String,Any}("backend" => "none", "format" => "none")
        descriptor["metadata"] = Dict{String,Any}("preview" => preview)
        return descriptor
    end

    if kind == KIND_MODULE
        descriptor["has_children"] = true
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "inline",
            "format" => FORMAT_MODULE_META,
            "value" => Dict{String,Any}(
                "module_id" => module_id(value),
                "name" => module_name(value),
                "version" => module_version(value),
            ),
        )
        descriptor["metadata"] = Dict{String,Any}(
            "module_id" => module_id(value),
            "name" => module_name(value),
            "version" => module_version(value),
            "preview" => preview,
        )
        return descriptor
    end

    # PDVFile subclasses
    _file_kind_map = Dict{String,Tuple{String,String}}(
        KIND_SCRIPT   => (".jl", FORMAT_JL_SCRIPT),
        KIND_MARKDOWN => (".md", FORMAT_MARKDOWN),
        KIND_GUI      => (".gui.json", FORMAT_GUI_JSON),
        KIND_LIB      => (".jl", FORMAT_JL_LIB),
    )

    if haskey(_file_kind_map, kind)
        ext, fmt = _file_kind_map[kind]
        source_path = resolve_file_path(value, using_source_dir)
        if !isfile(source_path)
            throw(PDVSerializationError("File not found: $source_path"))
        end
        if value isa PDVLib
            rp = relative_path(value)
            if isabspath(rp)
                rel_path = relpath(source_path, using_source_dir)
            else
                rel_path = rp
            end
        else
            file_path = working_dir_tree_path(working_dir, tree_path, ext)
            ensure_parent(file_path)
            if abspath(source_path) != abspath(file_path)
                cp(source_path, file_path; force=true)
            end
            rel_path = relpath(file_path, working_dir)
        end
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file",
            "relative_path" => rel_path,
            "format" => fmt,
        )
        meta = Dict{String,Any}("preview" => preview)
        if value isa PDVScript
            meta["language"] = language(value)
            meta["doc"] = doc(value)
        elseif value isa PDVLib
            meta["language"] = "julia"
            mid = module_id(value)
            if mid !== nothing
                meta["module_id"] = mid
            end
        elseif kind == KIND_GUI
            if value isa PDVGui && module_id(value) !== nothing
                meta["module_id"] = module_id(value)
            end
            meta["language"] = "json"
        elseif kind == KIND_MARKDOWN
            meta["language"] = "markdown"
            if value isa PDVNote && title(value) !== nothing
                meta["title"] = title(value)
            end
        end
        descriptor["metadata"] = meta
        return descriptor
    end

    if kind == KIND_HDF5
        descriptor["has_children"] = true
        rp = relative_path(value)
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file",
            "relative_path" => rp,
            "format" => "hdf5",
        )
        descriptor["metadata"] = Dict{String,Any}(
            "hdf5_path" => hdf5_path(value),
            "preview" => preview,
        )
        return descriptor
    end

    if kind == KIND_NAMELIST
        rp = relative_path(value)
        ext = splitext(rp)[2]
        if isempty(ext)
            ext = ".nml"
        end
        source_path = resolve_file_path(value, using_source_dir)
        if !isfile(source_path)
            throw(PDVSerializationError("File not found: $source_path"))
        end
        file_path = working_dir_tree_path(working_dir, tree_path, ext)
        ensure_parent(file_path)
        if abspath(source_path) != abspath(file_path)
            cp(source_path, file_path; force=true)
        end
        rel_path = relpath(file_path, working_dir)
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file",
            "relative_path" => rel_path,
            "format" => FORMAT_NAMELIST,
        )
        descriptor["metadata"] = Dict{String,Any}(
            "module_id" => module_id(value),
            "namelist_format" => namelist_format(value),
            "language" => "namelist",
            "preview" => preview,
        )
        return descriptor
    end

    if kind == KIND_NDARRAY
        file_path = working_dir_tree_path(working_dir, tree_path, ".jld2")
        ensure_parent(file_path)
        _save_array(file_path, value)
        rel_path = relpath(file_path, working_dir)
        descriptor["lazy"] = true
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file",
            "relative_path" => rel_path,
            "format" => FORMAT_JLD2,
        )
        descriptor["metadata"] = Dict{String,Any}(
            "shape" => collect(size(value)),
            "dtype" => string(eltype(value)),
            "size_bytes" => sizeof(value),
            "preview" => preview,
        )
        return descriptor
    end

    if kind == KIND_DATAFRAME
        file_path = working_dir_tree_path(working_dir, tree_path, ".arrow")
        ensure_parent(file_path)
        _save_dataframe(file_path, value)
        rel_path = relpath(file_path, working_dir)
        descriptor["lazy"] = true
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file",
            "relative_path" => rel_path,
            "format" => FORMAT_ARROW,
        )
        descriptor["metadata"] = Dict{String,Any}(
            "shape" => [size(value, 1), size(value, 2)],
            "preview" => preview,
        )
        return descriptor
    end

    if kind == KIND_SCALAR
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "inline",
            "format" => FORMAT_INLINE,
            "value" => value,
        )
        descriptor["metadata"] = Dict{String,Any}("preview" => preview)
        return descriptor
    end

    if kind == KIND_TEXT
        if length(value) <= 1000
            descriptor["storage"] = Dict{String,Any}(
                "backend" => "inline",
                "format" => FORMAT_INLINE,
                "value" => value,
            )
        else
            file_path = working_dir_tree_path(working_dir, tree_path, ".txt")
            ensure_parent(file_path)
            write(file_path, value)
            rel_path = relpath(file_path, working_dir)
            descriptor["lazy"] = true
            descriptor["storage"] = Dict{String,Any}(
                "backend" => "local_file",
                "relative_path" => rel_path,
                "format" => FORMAT_TXT,
            )
        end
        descriptor["metadata"] = Dict{String,Any}("preview" => preview)
        return descriptor
    end

    if kind in (KIND_MAPPING, KIND_SEQUENCE)
        try
            JSON.json(value)
        catch e
            throw(PDVSerializationError(
                "Value at '$tree_path' is not JSON-serializable: $e"
            ))
        end
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "inline",
            "format" => FORMAT_INLINE,
            "value" => value,
        )
        descriptor["metadata"] = Dict{String,Any}("preview" => preview)
        return descriptor
    end

    if kind == KIND_BINARY
        file_path = working_dir_tree_path(working_dir, tree_path, ".bin")
        ensure_parent(file_path)
        Base.write(file_path, value)
        rel_path = relpath(file_path, working_dir)
        descriptor["lazy"] = true
        descriptor["storage"] = Dict{String,Any}(
            "backend" => "local_file",
            "relative_path" => rel_path,
            "format" => "bin",
        )
        descriptor["metadata"] = Dict{String,Any}("preview" => preview)
        return descriptor
    end

    # KIND_UNKNOWN
    if !trusted
        throw(PDVSerializationError(
            "Cannot serialize value of type '$(typeof(value))' at path " *
            "'$tree_path'. Pass trusted=true to allow Julia Serialization."
        ))
    end
    file_path = working_dir_tree_path(working_dir, tree_path, ".jlser")
    ensure_parent(file_path)
    _save_serialized(file_path, value)
    rel_path = relpath(file_path, working_dir)
    descriptor["lazy"] = true
    descriptor["storage"] = Dict{String,Any}(
        "backend" => "local_file",
        "relative_path" => rel_path,
        "format" => FORMAT_JULIA_SERIALIZE,
    )
    descriptor["metadata"] = Dict{String,Any}("preview" => preview)
    return descriptor
end

"""
    deserialize_node(storage_ref, save_dir; trusted=false) -> Any

Deserialize a value from disk given a storage reference dict.
"""
function deserialize_node(storage_ref::Dict, save_dir::String; trusted::Bool=false)
    backend = get(storage_ref, "backend", "")

    if backend == "none"
        return Dict{String,Any}()
    end

    if backend == "inline"
        return storage_ref["value"]
    end

    if backend == "local_file"
        fmt = get(storage_ref, "format", "")
        rel_path = get(storage_ref, "relative_path", "")
        abs_path = joinpath(save_dir, rel_path)

        if !isfile(abs_path)
            throw(PDVSerializationError("Backing file not found: $abs_path"))
        end

        if fmt == FORMAT_JLD2
            return _load_array(abs_path)
        end

        if fmt == FORMAT_ARROW
            return _load_dataframe(abs_path)
        end

        if fmt == FORMAT_TXT || fmt == FORMAT_MARKDOWN
            return Base.read(abs_path, String)
        end

        if fmt == FORMAT_JSON || fmt == FORMAT_GUI_JSON
            return JSON.parsefile(abs_path)
        end

        if fmt == "bin"
            return Base.read(abs_path)
        end

        if fmt == FORMAT_JULIA_SERIALIZE
            if !trusted
                throw(PDVSerializationError(
                    "Julia Serialization deserialization is disabled. Pass trusted=true."
                ))
            end
            return _load_serialized(abs_path)
        end

        throw(PDVSerializationError("Unsupported storage format: '$fmt'"))
    end

    throw(PDVSerializationError("Unsupported storage backend: '$backend'"))
end

"""
    node_preview(value, kind::String) -> String

Generate a short human-readable preview string for the tree panel.
"""
function node_preview(value, kind::String)::String
    try
        if kind == KIND_FOLDER
            return "folder"
        end
        if kind in (KIND_MODULE, KIND_GUI, KIND_NAMELIST, KIND_LIB, KIND_HDF5,
                     KIND_SCRIPT, KIND_MARKDOWN)
            return file_preview(value)
        end
        if kind == KIND_SCALAR
            return string(value)[1:min(end, 100)]
        end
        if kind == KIND_TEXT
            s = string(value)
            return length(s) <= 50 ? s : s[1:50] * "..."
        end
        if kind == KIND_BINARY
            return "bytes ($(length(value)) bytes)"
        end
        if kind == KIND_MAPPING
            return "dict ($(length(value)) keys)"
        end
        if kind == KIND_SEQUENCE
            noun = value isa Tuple ? "tuple" : "vector"
            return "$noun ($(length(value)) items)"
        end
        if kind == KIND_NDARRAY
            shape_str = join(size(value), " × ")
            return "$(eltype(value)) array ($shape_str)"
        end
        if kind == KIND_DATAFRAME
            return "DataFrame ($(size(value, 1)) × $(size(value, 2)))"
        end
    catch
    end
    # Custom types with preview method
    if applicable(file_preview, value)
        try
            return string(file_preview(value))[1:min(end, 100)]
        catch
        end
    end
    return "<unknown type>"
end

"""
    extract_docstring_preview(file_path::String) -> Union{String,Nothing}

Extract the first line of a Julia file's module docstring.
"""
function extract_docstring_preview(file_path::String)::Union{String,Nothing}
    try
        for line in eachline(file_path)
            stripped = strip(line)
            # Look for a docstring (triple-quoted string or # comment at top)
            if startswith(stripped, "\"\"\"")
                # Read until closing """
                content = replace(stripped, "\"\"\"" => "", count=1)
                if !isempty(strip(content))
                    return strip(first(split(strip(content), "\n")))
                end
                # Multi-line: read next line
                continue
            elseif startswith(stripped, "#")
                doc = strip(lstrip(stripped, '#'))
                if !isempty(doc)
                    return doc
                end
            elseif !isempty(stripped)
                break
            end
        end
    catch
    end
    return nothing
end

# ---------------------------------------------------------------------------
# JLD2 array I/O (lazy-loaded)
# ---------------------------------------------------------------------------

function _save_array(file_path::String, value::AbstractArray)
    if isdefined(Main, :JLD2) || _try_load_jld2()
        jld2 = _get_jld2()
        jld2.save(file_path, "data", value)
    else
        # Fallback: Julia Serialization
        _save_serialized(file_path, value)
    end
end

function _load_array(file_path::String)
    if isdefined(Main, :JLD2) || _try_load_jld2()
        jld2 = _get_jld2()
        return jld2.load(file_path, "data")
    else
        return _load_serialized(file_path)
    end
end

# ---------------------------------------------------------------------------
# DataFrame I/O (lazy-loaded)
# ---------------------------------------------------------------------------

function _save_dataframe(file_path::String, value)
    arrow = _get_arrow()
    if arrow !== nothing
        arrow.write(file_path, value)
    else
        throw(PDVSerializationError("Arrow.jl is required to save DataFrames"))
    end
end

function _load_dataframe(file_path::String)
    arrow = _get_arrow()
    df_mod = _get_dataframes()
    if arrow !== nothing && df_mod !== nothing
        tbl = arrow.Table(Base.read(file_path))
        return df_mod.DataFrame(tbl)
    else
        throw(PDVSerializationError("Arrow.jl and DataFrames.jl are required to load DataFrames"))
    end
end

# ---------------------------------------------------------------------------
# Julia Serialization fallback
# ---------------------------------------------------------------------------

function _save_serialized(file_path::String, value)
    open(file_path, "w") do io
        Serialization.serialize(io, value)
    end
end

function _load_serialized(file_path::String)
    open(file_path, "r") do io
        return Serialization.deserialize(io)
    end
end

# ---------------------------------------------------------------------------
# Lazy package loading helpers
# ---------------------------------------------------------------------------

const _jld2_ref = Ref{Any}(nothing)
const _arrow_ref = Ref{Any}(nothing)
const _dataframes_ref = Ref{Any}(nothing)

function _try_load_jld2()::Bool
    try
        _jld2_ref[] = Base.require(Main, :JLD2)
        return true
    catch
        return false
    end
end

function _get_jld2()
    if _jld2_ref[] !== nothing
        return _jld2_ref[]
    end
    if _try_load_jld2()
        return _jld2_ref[]
    end
    return nothing
end

function _get_arrow()
    if _arrow_ref[] !== nothing
        return _arrow_ref[]
    end
    try
        _arrow_ref[] = Base.require(Main, :Arrow)
        return _arrow_ref[]
    catch
        return nothing
    end
end

function _get_dataframes()
    if _dataframes_ref[] !== nothing
        return _dataframes_ref[]
    end
    try
        _dataframes_ref[] = Base.require(Main, :DataFrames)
        return _dataframes_ref[]
    catch
        return nothing
    end
end
