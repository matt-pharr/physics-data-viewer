#=
solve.jl -- Integrate the general N-link pendulum equations of motion.

Uses DifferentialEquations.jl with configurable solvers. The state vector
is [theta_1, ..., theta_N, omega_1, ..., omega_N] where theta_i is the
angle of link i from vertical and omega_i is its angular velocity.

The equations are derived from the Lagrangian. For N links with masses
m_i and lengths L_i, the mass matrix M and forcing vector f are:

    M_ij = sum_{k=max(i,j)}^{N} m_k * L_i * L_j * cos(theta_i - theta_j)

    f_i  = - sum_j M'_ij * omega_j^2 * sin(theta_i - theta_j)
           - g * C_i * L_i * sin(theta_i)
           - b * omega_i

where C_i = sum_{k=i}^{N} m_k (the "tail mass" from link i onward).
=#

using DifferentialEquations
using LinearAlgebra

# NPendulum exports (e.g. PendulumSolution) are made available by the PDV
# framework from the module's lib branch — no manual include/using needed.


# ---------------------------------------------------------------------------
# Physics
# ---------------------------------------------------------------------------

"""
    build_system!(M, f, theta, omega, masses, lengths, g, b)

Fill the mass matrix `M` and force vector `f` for the current state.
The accelerations satisfy `M * omega_dot = f`.
"""
function build_system!(M::Matrix{Float64}, f::Vector{Float64},
                       theta::AbstractVector{Float64}, omega::AbstractVector{Float64},
                       masses::Vector{Float64}, lengths::Vector{Float64},
                       g::Float64, b::Float64)
    N = length(masses)

    # Precompute tail masses: C[i] = sum(masses[i:end])
    C = zeros(N)
    C[N] = masses[N]
    for i in (N-1):-1:1
        C[i] = C[i+1] + masses[i]
    end

    # Mass matrix
    for i in 1:N
        for j in 1:N
            k_start = max(i, j)
            M[i, j] = C[k_start] * lengths[i] * lengths[j] * cos(theta[i] - theta[j])
        end
    end

    # Force vector
    for i in 1:N
        fi = 0.0
        # Coriolis / centrifugal
        for j in 1:N
            k_start = max(i, j)
            fi -= C[k_start] * lengths[i] * lengths[j] * omega[j]^2 * sin(theta[i] - theta[j])
        end
        # Gravity
        fi -= g * C[i] * lengths[i] * sin(theta[i])
        # Damping
        fi -= b * omega[i]
        f[i] = fi
    end

    return nothing
end


"""
    derivatives!(dy, y, params, t)

Compute dy/dt for the N-link pendulum (in-place for DifferentialEquations.jl).
"""
function derivatives!(dy::Vector{Float64}, y::Vector{Float64}, params::NamedTuple, t::Float64)
    N = params.N
    masses = params.masses
    lengths = params.lengths
    g = params.g
    b = params.b
    M = params.M_buf
    f = params.f_buf

    theta = @view y[1:N]
    omega = @view y[N+1:2N]

    build_system!(M, f, theta, omega, masses, lengths, g, b)
    alpha = M \ f

    dy[1:N] .= omega
    dy[N+1:2N] .= alpha

    return nothing
end


# ---------------------------------------------------------------------------
# Script entry point
# ---------------------------------------------------------------------------

"""
    run(pdv_tree; kwargs...)

Integrate the N-link pendulum and store the result in the PDV tree.

PDV script function signature: run(pdv_tree; kwargs...)
"""
function run(pdv_tree;
             n_links::Int = 2,
             damping::Float64 = 0.0,
             t_end::Float64 = 20.0,
             n_steps::Int = 4000,
             integration_method::String = "Tsit5",
             strict_tolerances::Bool = false,
             rtol::Float64 = 1e-10,
             atol::Float64 = 1e-12,
             init_state_file::String = "",
             output_dir::String = "",
             solve_output_key::String = "result",
             theta0_deg::Float64 = 120.0,
             mass::Float64 = 1.0,
             length::Float64 = 1.0,
             g::Float64 = 9.81,
             kwargs...)

    N = Int(n_links)
    N < 1 && error("n_links must be at least 1")
    N > 10 && error("n_links above 10 is not recommended (solver may be very slow)")
    n_steps < 2 && error("n_steps must be at least 2")

    output_key = strip(solve_output_key)
    isempty(output_key) && error("solve_output_key must be a non-empty string")

    # Map method names to DifferentialEquations.jl solvers
    method_map = Dict(
        "Tsit5"  => Tsit5(),
        "Vern7"  => Vern7(),
        "Rodas5P" => Rodas5P(),
    )
    method_key = strip(integration_method)
    if !haskey(method_map, method_key)
        error("Unsupported integration_method: $integration_method. Choose from: Tsit5, Vern7, Rodas5P")
    end
    method = method_map[method_key]

    # Build uniform mass/length arrays
    masses  = fill(Float64(mass), N)
    lengths = fill(Float64(length), N)

    # Initial conditions: first link at theta0, rest at small alternating
    # perturbations so they fan out quickly.
    theta_init = zeros(N)
    theta_init[1] = deg2rad(theta0_deg)
    for i in 2:N
        theta_init[i] = deg2rad((-1)^i * 5.0)
    end
    omega_init = zeros(N)
    y0 = vcat(theta_init, omega_init)

    t_eval = LinRange(0.0, t_end, n_steps)

    names_dict = Dict(1 => "single", 2 => "double", 3 => "triple", 4 => "quadruple")
    label = get(names_dict, N, "$(N)-link")
    println("[N-Pendulum] Solving $label pendulum: t_end=$(t_end)s, " *
            "n_steps=$n_steps, damping=$damping, theta0=$(theta0_deg) deg")

    # Preallocate work buffers for the mass matrix and force vector
    M_buf = zeros(N, N)
    f_buf = zeros(N)

    params = (N=N, masses=masses, lengths=lengths, g=Float64(g), b=Float64(damping),
              M_buf=M_buf, f_buf=f_buf)

    reltol = strict_tolerances ? rtol : 1e-8
    abstol = strict_tolerances ? atol : 1e-10

    prob = ODEProblem(derivatives!, y0, (0.0, t_end), params)
    sol = solve(prob, method; saveat=collect(t_eval), reltol=reltol, abstol=abstol)

    if sol.retcode != :Success && sol.retcode != ReturnCode.Success
        error("ODE solver failed with return code: $(sol.retcode)")
    end

    # Extract solution arrays
    t_out = sol.t
    n_out = Base.length(t_out)

    thetas = zeros(N, n_out)
    omegas = zeros(N, n_out)
    for k in 1:n_out
        for i in 1:N
            thetas[i, k] = sol.u[k][i]
            omegas[i, k] = sol.u[k][N + i]
        end
    end

    # Cartesian positions of each bob (cumulative sum of link vectors)
    xs = zeros(N, n_out)
    ys = zeros(N, n_out)
    for i in 1:N
        for k in 1:n_out
            xs[i, k] = (i > 1 ? xs[i-1, k] : 0.0) + lengths[i] * sin(thetas[i, k])
            ys[i, k] = (i > 1 ? ys[i-1, k] : 0.0) - lengths[i] * cos(thetas[i, k])
        end
    end

    # Store the solution in the tree
    params_dict = Dict{String,Any}(
        "N" => N,
        "masses" => collect(masses),
        "lengths" => collect(lengths),
        "g" => g,
        "damping" => damping,
        "t_end" => t_end,
        "n_steps" => n_steps,
        "theta0_deg" => theta0_deg,
        "integration_method" => method_key,
        "strict_tolerances" => strict_tolerances,
        "rtol" => rtol,
        "atol" => atol,
        "init_state_file" => strip(init_state_file),
        "output_dir" => strip(output_dir),
    )

    solution = PendulumSolution(t_out, thetas, omegas, xs, ys, params_dict)
    pdv_tree["n_pendulum_julia.outputs.$output_key"] = solution

    println("[N-Pendulum] Solved $n_out time steps ($(t_end)s) successfully.")
    println("[N-Pendulum] Double-click 'n_pendulum_julia.$output_key' in the tree to plot.")

    return Dict("status" => "ok", "n_links" => N, "n_steps" => Base.length(t_out))
end
