#=
animate.jl -- Visualise the N-link pendulum solution.

Produces a multi-panel figure:
  1. Phase-space trajectory of the final bob (x_N vs y_N).
  2. Time series of all link angles.
  3. Overlay of sampled arm configurations colour-coded by time.

Uses CairoMakie for rendering.
=#

using CairoMakie

# NPendulum exports (e.g. PendulumSolution) are made available by the PDV
# framework from the module's lib branch — no manual include/using needed.


# ---------------------------------------------------------------------------
# Script entry point
# ---------------------------------------------------------------------------

"""
    run(pdv_tree; kwargs...)

Visualise a pendulum solution from the PDV tree as a 3-panel figure.

PDV script function signature: run(pdv_tree; kwargs...)
"""
function run(pdv_tree;
             animate_output_key::String = "result",
             render_style::String = "trajectory",
             n_frames::Int = 200,
             trail_alpha::Float64 = 0.15,
             show_legend::Bool = true,
             output_dir::String = "",
             kwargs...)

    output_key = strip(animate_output_key)
    isempty(output_key) && error("animate_output_key must be a non-empty string")

    style = lowercase(strip(render_style))
    style in ("trajectory", "angles") || error("render_style must be one of: trajectory, angles")

    n_frames < 1 && error("n_frames must be at least 1")
    (trail_alpha < 0.0 || trail_alpha > 1.0) && error("trail_alpha must be between 0.0 and 1.0")

    output_dir = strip(output_dir)

    # ------------------------------------------------------------------
    # Pull solution data from tree
    # ------------------------------------------------------------------
    root = "n_pendulum_julia.outputs.$output_key"
    local sol::PendulumSolution
    try
        sol = pdv_tree[root]
    catch e
        error("No PendulumSolution found at '$root'. Run the ODE solver first.")
    end

    t      = sol.t
    xs     = sol.xs        # (N, n_steps)
    ys     = sol.ys        # (N, n_steps)
    thetas = sol.thetas    # (N, n_steps)
    params = sol.params

    N = Int(params["N"])
    link_lengths = Float64.(params["lengths"])
    total_L = sum(link_lengths)
    n_pts = Base.length(t)
    n_frames = min(n_frames, n_pts)
    frame_idx = round.(Int, LinRange(1, n_pts, n_frames))

    names_dict = Dict(1 => "Single", 2 => "Double", 3 => "Triple", 4 => "Quadruple")
    title = get(names_dict, N, "$(N)-Link") * " Pendulum"

    # ------------------------------------------------------------------
    # Figure layout: 3 panels
    # ------------------------------------------------------------------
    fig = Figure(size = (1700, 550))
    Label(fig[0, 1:3], title, fontsize = 18, font = :bold)

    # --- Panel 1: Phase portrait of the final bob ---
    ax1 = Axis(fig[1, 1], aspect = DataAspect())
    if style == "trajectory"
        xN = xs[N, :]
        yN = ys[N, :]
        color_vals = range(0.0, 1.0, length = n_pts)
        lines!(ax1, xN, yN; color = color_vals, colormap = :viridis, linewidth = 0.8)
        ax1.xlabel = "x$N"
        ax1.ylabel = "y$N"
        ax1.title = "Bob $N trajectory"
    else
        hidedecorations!(ax1)
        text!(ax1, 0.5, 0.5; text = "Trajectory hidden\n(render_style=angles)",
              align = (:center, :center), fontsize = 12, space = :relative)
    end

    # --- Panel 2: Angle time series for all links ---
    ax2 = Axis(fig[1, 2], xlabel = "Time (s)", ylabel = "Angle (deg)",
               title = "Angles vs time")
    for i in 1:N
        lines!(ax2, t, rad2deg.(thetas[i, :]), linewidth = 0.8, label = "theta$i")
    end
    if show_legend && N > 0
        axislegend(ax2; position = :rt, labelsize = 10)
    end

    # --- Panel 3: Arm position overlay (sampled frames) ---
    ax3 = Axis(fig[1, 3], aspect = DataAspect(), title = "Arm positions (sampled)")
    if style == "trajectory"
        xlims!(ax3, -total_L * 1.15, total_L * 1.15)
        ylims!(ax3, -total_L * 1.15, total_L * 0.5)

        for (fi, idx) in enumerate(frame_idx)
            frac = (fi - 1) / max(n_frames - 1, 1)
            alpha = trail_alpha + (1.0 - trail_alpha) * frac
            color = Makie.cgrad(:plasma)[frac]

            # Build polyline: pivot (0,0) -> bob1 -> bob2 -> ... -> bobN
            arm_x = zeros(N + 1)
            arm_y = zeros(N + 1)
            for i in 1:N
                arm_x[i + 1] = xs[i, idx]
                arm_y[i + 1] = ys[i, idx]
            end

            lines!(ax3, arm_x, arm_y; color = (color, alpha), linewidth = 0.8)
            scatter!(ax3, arm_x, arm_y; color = (color, alpha), markersize = 3)
        end

        # Pivot marker
        scatter!(ax3, [0.0], [0.0]; color = :black, marker = :rect, markersize = 8)
    else
        hidedecorations!(ax3)
        text!(ax3, 0.5, 0.5; text = "Arm overlay hidden\n(render_style=angles)",
              align = (:center, :center), fontsize = 12, space = :relative)
    end

    display(fig)

    println("[N-Pendulum] Plotted $n_frames frames for $N-link pendulum.")
    return Dict("status" => "ok", "n_frames" => n_frames, "render_style" => style, "output_dir" => output_dir)
end
