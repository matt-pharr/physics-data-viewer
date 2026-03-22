"""
NPendulum -- Custom types for the N-Pendulum PDV module.

Defines the `PendulumSolution` struct stored as a tree node by `solve.jl`.
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
