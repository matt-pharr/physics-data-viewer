"""
NPendulum -- Custom types and handlers for the N-Pendulum PDV module.

Defines the `PendulumSolution` struct stored as a tree node by `solve.jl`,
and registers a double-click handler that produces a quick overview plot
(trajectory + angle time series) when the user double-clicks a solution
node in the tree.
"""
module NPendulum

export PendulumSolution, n_links, n_steps, preview

"""
    PendulumSolution

Solution of an N-link pendulum ODE integration.

# Fields
- `t::Vector{Float64}` -- Time array.
- `thetas::Matrix{Float64}` -- Joint angles (N x n_steps), radians.
- `omegas::Matrix{Float64}` -- Angular velocities (N x n_steps), rad/s.
- `xs::Matrix{Float64}` -- Cartesian x-coordinates of each bob (N x n_steps).
- `ys::Matrix{Float64}` -- Cartesian y-coordinates of each bob (N x n_steps).
- `params::Dict{String,Any}` -- Solver parameters used to produce the solution.
"""
struct PendulumSolution
    t::Vector{Float64}
    thetas::Matrix{Float64}
    omegas::Matrix{Float64}
    xs::Matrix{Float64}
    ys::Matrix{Float64}
    params::Dict{String,Any}
end

n_links(sol::PendulumSolution) = Int(sol.params["N"])
n_steps(sol::PendulumSolution) = length(sol.t)

function preview(sol::PendulumSolution)
    names = Dict(1 => "single", 2 => "double", 3 => "triple", 4 => "quadruple")
    label = get(names, n_links(sol), "$(n_links(sol))-link")
    "$label pendulum ($(n_steps(sol)) steps, $(sol.t[end])s)"
end

end  # module NPendulum

# ---------------------------------------------------------------------------
# Handler registration — runs at include() time in Main, after PDVKernel is
# already loaded, so PDVKernel.pdv_handle is accessible.
# ---------------------------------------------------------------------------

import PDVKernel: pdv_handle, pdv_preview, PDVTree
using CairoMakie

"""
    pdv_preview(sol::NPendulum.PendulumSolution) -> String

Short description for the tree panel preview column.
"""
function pdv_preview(sol::NPendulum.PendulumSolution)::String
    return NPendulum.preview(sol)
end

"""
    pdv_handle(sol::NPendulum.PendulumSolution, path::String, tree::PDVTree)

Quick overview plot: final-bob trajectory + angle time series.
Invoked when the user double-clicks a `PendulumSolution` node in the tree.
"""
function pdv_handle(sol::NPendulum.PendulumSolution, path::String, tree::PDVTree)
    t      = sol.t
    xs     = sol.xs        # (N, n_steps)
    ys     = sol.ys        # (N, n_steps)
    thetas = sol.thetas    # (N, n_steps)
    params = sol.params

    N = Int(params["N"])
    link_lengths = Float64.(params["lengths"])
    total_L = sum(link_lengths)
    n_pts = length(t)

    names_dict = Dict(1 => "Single", 2 => "Double", 3 => "Triple", 4 => "Quadruple")
    title = get(names_dict, N, "$(N)-Link") * " Pendulum"

    fig = CairoMakie.Figure(size = (1200, 500))
    CairoMakie.Label(fig[0, 1:2], title, fontsize = 18, font = :bold)

    # --- Panel 1: Final-bob trajectory coloured by time ---
    ax1 = CairoMakie.Axis(fig[1, 1], aspect = CairoMakie.DataAspect())
    xN = xs[N, :]
    yN = ys[N, :]
    color_vals = range(0.0, 1.0, length = n_pts)
    CairoMakie.lines!(ax1, xN, yN; color = color_vals, colormap = :viridis, linewidth = 0.8)
    ax1.xlabel = "x$N"
    ax1.ylabel = "y$N"
    ax1.title = "Bob $N trajectory"

    # --- Panel 2: Angle time series for all links ---
    ax2 = CairoMakie.Axis(fig[1, 2], xlabel = "Time (s)", ylabel = "Angle (deg)",
                           title = "Angles vs time")
    for i in 1:N
        CairoMakie.lines!(ax2, t, rad2deg.(thetas[i, :]), linewidth = 0.8, label = "θ$i")
    end
    if N > 0
        CairoMakie.axislegend(ax2; position = :rt, labelsize = 10)
    end

    display(fig)
    println("[N-Pendulum] Plotted solution at '$path'")
    return nothing
end
