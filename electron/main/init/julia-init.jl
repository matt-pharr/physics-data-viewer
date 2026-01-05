#=
Physics Data Viewer - Julia Kernel Initialization

This file is executed when a Julia kernel starts.
It sets up the environment, configures plot backends, and defines helper functions.
=#

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

Get detailed information about an object for display in the Tree.

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

    # DataFrames (if available)
    elseif hasproperty(obj, :columns) && hasproperty(obj, :nrow)
        info["shape"] = [obj.nrow, length(obj.columns)]
        info["columns"] = string.(obj.columns)
        info["preview"] = "DataFrame ($(obj.nrow) rows, $(length(obj.columns)) cols)"

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

    else
        repr_str = repr(obj)
        info["preview"] = repr_str[1:min(100, length(repr_str))]
    end

    return info
end

# =============================================================================
# Namespace Management
# =============================================================================

"""
    pdv_namespace()

Get the current namespace as a Dict suitable for the Tree view.
"""
function pdv_namespace()
    # This is a stub; real implementation would inspect Main module
    result = Dict{String, Any}()

    for name in names(Main, all=false, imported=false)
        # Skip private names
        startswith(string(name), "_") && continue

        try
            obj = getfield(Main, name)
            # Skip functions and modules
            obj isa Function && continue
            obj isa Module && continue

            result[string(name)] = pdv_info(obj)
        catch
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
println("  - Capture mode: $(_capture_mode ? \"enabled\" :  \"disabled\")")
