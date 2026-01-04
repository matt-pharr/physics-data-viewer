# Physics Data Viewer - Julia kernel initialization
# This file is executed when a Julia kernel starts.

# --- Plot backend setup ---
# The backend will be selected based on the capture mode: 
# - Native mode: Use GR or GLMakie (opens native windows)
# - Capture mode: Use GR with PNG output for inline display

# using Plots
# 
# function _setup_plot_backend(capture_mode::Bool=false)
#     if capture_mode
#         gr(show=false)  # GR backend without display
#     else
#         gr()  # GR backend with native windows
#     end
# end

# --- pdv_show() helper ---
# Captures the current plot and returns it as base64 PNG/SVG
# for display in the Physics Data Viewer UI. 
#
# function pdv_show(p=Plots.current(); fmt=: png)
#     io = IOBuffer()
#     savefig(p, io, fmt)
#     data = base64encode(take!(io))
#     return Dict("mime" => "image/$fmt", "data" => data)
# end

# --- Revise. jl for hot reload (optional) ---
# try
#     using Revise
# catch e
#     @warn "Revise.jl not available.  Hot reload disabled."
# end

println("Physics Data Viewer Julia kernel initialized.")