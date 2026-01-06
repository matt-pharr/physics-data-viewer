#=
Physics Data Viewer - Julia Kernel Initialization

This file is executed when a Julia kernel starts.
It sets up the environment, configures plot backends, and defines helper functions.
=#

const MAX_COLUMNS = 20
const MAX_PREVIEW_LENGTH = 100

# =============================================================================
# PDV Tree Object
# =============================================================================

"""
PDVTree

Enhanced Dict that acts as the tree object in kernel namespace.
"""
mutable struct PDVTree
    data::Dict{String, Any}
    project_root::String
    tree_root::String

    function PDVTree(project_root::String=pwd())
        tree_root = joinpath(project_root, "tree")
        new(Dict{String, Any}(), project_root, tree_root)
    end
end

# Make PDVTree behave like a Dict
Base.getindex(tree::PDVTree, key::String) = tree.data[key]
Base.setindex!(tree::PDVTree, value, key::String) = tree.data[key] = value
Base.haskey(tree::PDVTree, key::String) = haskey(tree.data, key)
Base.keys(tree::PDVTree) = keys(tree.data)
Base.values(tree::PDVTree) = values(tree.data)

"""
    run_script(tree::PDVTree, script_path::String; kwargs...)

Execute a script file with parameters.
"""
function run_script(tree::PDVTree, script_path::String; kwargs...)
    path_parts = split(script_path, '.')
    file_path = joinpath(tree.tree_root, path_parts...) * ".jl"

    if !isfile(file_path)
        error("Script not found: $file_path")
    end

    script_module = Module()
    Core.eval(script_module, :(tree = $tree))
    Base.include(script_module, file_path)

    if !isdefined(script_module, :run)
        error("Script $script_path does not have a run() function")
    end

    run_func = getfield(script_module, :run)
    return run_func(tree; kwargs...)
end

# Create global tree instance
tree = PDVTree(get(ENV, "PDV_PROJECT_ROOT", pwd()))

# Initialize tree structure
tree["data"] = Dict{String, Any}()
tree["scripts"] = Dict{String, Any}()
tree["results"] = Dict{String, Any}()

# =============================================================================
# Plot Backend Configuration
# =============================================================================

"""
    _pdv_setup_plots(capture_mode::Bool=false)

Configure Plots.jl backend based on capture mode.

# Arguments
- `capture_mode`: If true, configure for image capture; otherwise use interactive display.
"""
function _pdv_setup_plots(capture_mode::Bool=false)
    try
        using Plots

        if capture_mode
            # Use GR with no display for capturing
            gr(show=false, size=(800, 600))
            println("[PDV] Plots backend: GR (capture mode, show=false)")
        else
            # Use GR with interactive display
            gr(size=(800, 600))
            println("[PDV] Plots backend: GR (native mode)")
        end
    catch e
        println("[PDV] Plots.jl not installed: $e")
    end
end

# =============================================================================
# Plot Capture Helper
# =============================================================================

"""
    pdv_show(p=nothing; fmt=:png, dpi=100)

Capture a plot and return it as base64 for display in PDV UI.

# Arguments
- `p`: The plot to capture. If nothing, uses the current plot.
- `fmt`: Output format (`:png` or `:svg`).
- `dpi`: Resolution for raster formats.

# Returns
- `Dict`: `{"mime" => "image/png", "data" => "<base64 string>"}`

# Example
```julia
using Plots
plot([1, 2, 3], [1, 4, 9])
pdv_show()  # Captures and returns the figure
```
"""
function pdv_show(p=nothing; fmt=:png, dpi=100)
    try
        using Plots
        using Base64

        if p === nothing
            p = Plots.current()
        end

        # Check if plot is empty
        if length(p.series_list) == 0
            return Dict("error" => "No plot to capture (plot is empty)")
        end

        io = IOBuffer()
        if fmt == :png
            savefig(p, io, :png; dpi=dpi)
        elseif fmt == :svg
            savefig(p, io, :svg)
        else
            return Dict("error" => "Unsupported format: $fmt (use :png or :svg)")
        end

        seekstart(io)
        data = base64encode(take!(io))

        return Dict("mime" => "image/$fmt", "data" => data)

    catch e
        return Dict("error" => string(e))
    end
end

# =============================================================================
# Data Inspection Helpers
# =============================================================================

"""
    pdv_info(obj)

Get detailed information about an object for display in the Tree/Namespace.

# Returns
- `Dict`: Object metadata including type, shape, dtype, preview, etc.
"""
function pdv_info(obj)
    info = Dict{String, Any}(
        "type" => string(typeof(obj)),
        "module" => string(parentmodule(typeof(obj)))
    )

    # Arrays
    if obj isa AbstractArray
        info["shape"] = collect(size(obj))
        info["dtype"] = string(eltype(obj))
        info["size"] = sizeof(obj)
        info["preview"] = "$(eltype(obj)) $(size(obj))"
        
        # Add min/max/mean for numeric arrays
        try
            if length(obj) > 0 && eltype(obj) <: Number
                min_val, max_val = extrema(obj)
                info["min"] = Float64(min_val)
                info["max"] = Float64(max_val)
                info["mean"] = Float64(sum(obj) / length(obj))
            end
        catch
        end

    # DataFrames (if available)
    elseif hasproperty(obj, :colindex) && hasproperty(obj, :nrow)
        columns = names(obj)
        info["shape"] = [obj.nrow, length(columns)]
        info["columns"] = string.(columns[1:min(MAX_COLUMNS, end)])
        info["preview"] = "DataFrame ($(obj.nrow) rows, $(length(columns)) cols)"
        # Size estimation
        info["size"] = sum(sizeof(col) for col in eachcol(obj))

    # Dicts
    elseif obj isa AbstractDict
        info["length"] = length(obj)
        info["keys"] = string.(collect(keys(obj))[1:min(10, length(obj))])
        info["preview"] = "Dict ($(length(obj)) items)"

    # Tuples
    elseif obj isa Tuple
        info["length"] = length(obj)
        info["preview"] = "Tuple ($(length(obj)) items)"

    # Strings
    elseif obj isa AbstractString
        info["length"] = length(obj)
        preview = length(obj) > 50 ? obj[1:50] * "..." : obj
        info["preview"] = repr(preview)

    # Numbers
    elseif obj isa Number
        info["preview"] = string(obj)

    # Booleans
    elseif obj isa Bool
        info["preview"] = string(obj)

    # Nothing
    elseif obj === nothing
        info["preview"] = "nothing"

    # Generic objects
    else
        repr_str = repr(obj)
        info["preview"] = repr_str[1:min(MAX_PREVIEW_LENGTH, length(repr_str))]
    end

    return info
end

# =============================================================================
# Namespace Management
# =============================================================================

"""
    pdv_namespace(; include_private::Bool=false, include_modules::Bool=false)

Get the current namespace as a Dict suitable for the Namespace view. 

# Arguments
- `include_private`: If false, exclude names starting with '_'
- `include_modules`: If false, exclude Module objects

# Returns
- `Dict{String, Any}`: Variable name => metadata dict
"""
function pdv_namespace(; include_private::Bool=false, include_modules::Bool=false)
    result = Dict{String, Any}()
    
    # Get names from Main module
    for name in names(Main, all=false, imported=false)
        name_str = string(name)
        
        # Skip private names (unless requested)
        if !include_private && startswith(name_str, "_")
            continue
        end
        
        # Skip PDV internals
        if startswith(name_str, "pdv_") || startswith(name_str, "_pdv_")
            continue
        end
        
        try
            obj = getfield(Main, name)
            
            # Skip modules (unless requested)
            if !include_modules && obj isa Module
                continue
            end
            
            # Skip functions (unless they're data-like)
            if obj isa Function
                continue
            end
            
            # Get metadata
            info = pdv_info(obj)
            result[name_str] = info
            
        catch e
            # Skip names that can't be accessed
            continue
        end
    end
    
    return result
end

# =============================================================================
# Revise.jl Integration (optional hot reload)
# =============================================================================

function _pdv_setup_revise()
    try
        using Revise
        println("[PDV] Revise.jl loaded - hot reload enabled")
    catch
        println("[PDV] Revise.jl not available - hot reload disabled")
    end
end

# =============================================================================
# Initialization
# =============================================================================

# Uncomment to enable Revise.jl:
# _pdv_setup_revise()

# Check if capture mode is enabled via environment variable
_capture_mode = get(ENV, "PDV_CAPTURE_MODE", "") == "true"

# Configure Plots backend
_pdv_setup_plots(_capture_mode)

println("Physics Data Viewer Julia kernel initialized.")
println("  - pdv_show(): Capture current plot")
println("  - pdv_info(obj): Get object metadata")
println("  - Capture mode: $(_capture_mode ? \"enabled\" : \"disabled\")")
