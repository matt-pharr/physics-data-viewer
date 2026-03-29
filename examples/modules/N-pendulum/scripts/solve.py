"""
solve.py — Integrate the general N-link pendulum equations of motion.

Uses scipy.integrate.solve_ivp with the RK45 method.  The state vector
is [theta_1, ..., theta_N, omega_1, ..., omega_N] where theta_i is the
angle of link *i* from vertical and omega_i is its angular velocity.

The equations are derived from the Lagrangian.  For N links with masses
m_i and lengths L_i, the mass matrix M and forcing vector f are:

    M_ij = sum_{k=max(i,j)}^{N} m_k * L_i * L_j * cos(theta_i - theta_j)

    f_i  = - sum_{j} M'_ij * omega_j^2 * sin(theta_i - theta_j)
           - g * C_i * L_i * sin(theta_i)
           - b * omega_i

where C_i = sum_{k=i}^{N} m_k (the "tail mass" from link i onward).

The system is solved as  M * omega_dot = f  at each time step.
"""

import numpy as np
from scipy.integrate import solve_ivp

from n_pendulum import PendulumSolution


# ---------------------------------------------------------------------------
# Physics
# ---------------------------------------------------------------------------

def _build_system(theta, omega, masses, lengths, g, b):
    """Return (M, f) for the current state.

    M is the N x N mass matrix, f is the N-vector of generalised forces.
    The accelerations satisfy  M @ omega_dot = f.
    """
    N = len(masses)

    # Precompute tail masses:  C[i] = sum(m[i:])
    C = np.zeros(N)
    C[-1] = masses[-1]
    for i in range(N - 2, -1, -1):
        C[i] = C[i + 1] + masses[i]

    # Mass matrix
    M = np.zeros((N, N))
    for i in range(N):
        for j in range(N):
            k_start = max(i, j)
            M[i, j] = C[k_start] * lengths[i] * lengths[j] * np.cos(theta[i] - theta[j])

    # Force vector
    f = np.zeros(N)
    for i in range(N):
        # Coriolis / centrifugal
        for j in range(N):
            k_start = max(i, j)
            f[i] -= C[k_start] * lengths[i] * lengths[j] * omega[j] ** 2 * np.sin(theta[i] - theta[j])
        # Gravity
        f[i] -= g * C[i] * lengths[i] * np.sin(theta[i])
        # Damping
        f[i] -= b * omega[i]

    return M, f


def _derivatives(t, y, masses, lengths, g, b):
    """Compute dy/dt for the N-link pendulum."""
    N = len(masses)
    theta = y[:N]
    omega = y[N:]

    M, f = _build_system(theta, omega, masses, lengths, g, b)
    alpha = np.linalg.solve(M, f)

    return np.concatenate([omega, alpha])


# ---------------------------------------------------------------------------
# Script entry point
# ---------------------------------------------------------------------------

def run(
    pdv_tree: dict,
    n_links: int = 2,
    damping: float = 0.0,
    t_end: float = 20.0,
    n_steps: int = 4000,
    integration_method: str = "RK45",
    strict_tolerances: bool = False,
    rtol: float = 1e-10,
    atol: float = 1e-12,
    init_state_file: str = "",
    output_dir: str = "",
    solve_output_key: str = "result",
    theta0_deg: float = 120.0,
    mass: float = 1.0,
    length: float = 1.0,
    g: float = 9.81,
) -> dict:
    """Integrate the N-link pendulum.

    Parameters
    ----------
    n_links : int
        Number of pendulum links (2 = double, 3 = triple, etc.).
    damping : float
        Viscous damping coefficient at every joint.
    t_end : float
        Total integration time in seconds.
    theta0_deg : float
        Initial angle (degrees) for the *first* link.  All other links
        start at small perturbations off vertical so the system is
        visually interesting from the start.
    mass : float
        Mass of every bob (uniform).
    length : float
        Length of every link (uniform).
    g : float
        Gravitational acceleration.
    n_steps : int
        Number of output time steps.
    """
    N = int(n_links)
    if N < 1:
        raise ValueError("n_links must be at least 1")
    if N > 10:
        raise ValueError("n_links above 10 is not recommended (solver may be very slow)")

    damping = float(damping)
    t_end = float(t_end)
    n_steps = int(n_steps)
    method_key = str(integration_method).strip().upper()
    strict = bool(strict_tolerances)
    rtol_value = float(rtol)
    atol_value = float(atol)
    init_state_file = str(init_state_file).strip()
    output_dir = str(output_dir).strip()
    output_key = str(solve_output_key).strip()
    if not output_key:
        raise ValueError("solve_output_key must be a non-empty string")
    if n_steps < 2:
        raise ValueError("n_steps must be at least 2")
    method_map = {"RK45": "RK45", "DOP853": "DOP853", "RADAU": "Radau"}
    method = method_map.get(method_key)
    if method is None:
        raise ValueError(f"Unsupported integration_method: {integration_method}")

    # Build uniform mass/length arrays.
    masses  = np.full(N, mass)
    lengths = np.full(N, length)

    # Initial conditions: first link at theta0, rest at small alternating
    # perturbations so they fan out quickly.
    theta_init = np.zeros(N)
    theta_init[0] = np.radians(theta0_deg)
    for i in range(1, N):
        theta_init[i] = np.radians((-1) ** i * 5.0)
    omega_init = np.zeros(N)
    y0 = np.concatenate([theta_init, omega_init])

    t_eval = np.linspace(0, t_end, n_steps)

    names = {1: "single", 2: "double", 3: "triple", 4: "quadruple"}
    label = names.get(N, f"{N}-link")
    print(f"[N-Pendulum] Solving {label} pendulum: t_end={t_end}s, "
          f"n_steps={n_steps}, damping={damping}, theta0={theta0_deg} deg")

    sol = solve_ivp(
        _derivatives,
        [0, t_end],
        y0,
        method=method,
        t_eval=t_eval,
        args=(masses, lengths, g, damping),
        rtol=rtol_value if strict else 1e-8,
        atol=atol_value if strict else 1e-10,
    )

    if not sol.success:
        raise RuntimeError(f"ODE solver failed: {sol.message}")

    t = sol.t
    thetas = sol.y[:N]     # shape (N, n_steps)
    omegas = sol.y[N:]     # shape (N, n_steps)

    # Cartesian positions of each bob (cumulative sum of link vectors).
    xs = np.zeros((N, len(t)))
    ys = np.zeros((N, len(t)))
    for i in range(N):
        xs[i] = (xs[i - 1] if i > 0 else 0.0) + lengths[i] * np.sin(thetas[i])
        ys[i] = (ys[i - 1] if i > 0 else 0.0) - lengths[i] * np.cos(thetas[i])

    # Store the solution as a PendulumSolution object in the tree.
    # Double-clicking this node in the tree triggers the registered handler
    # which produces an overview plot (see n_pendulum/__init__.py).
    params_dict = {
        "N": N, "masses": masses.tolist(), "lengths": lengths.tolist(),
        "g": g, "damping": damping, "t_end": t_end, "n_steps": n_steps,
        "theta0_deg": theta0_deg,
        "integration_method": method,
        "strict_tolerances": strict,
        "rtol": rtol_value,
        "atol": atol_value,
        "init_state_file": init_state_file,
        "output_dir": output_dir,
    }

    solution = PendulumSolution(
        t=t, thetas=thetas, omegas=omegas, xs=xs, ys=ys, params=params_dict,
    )
    pdv_tree[f"n_pendulum.outputs.{output_key}"] = solution

    print(f"[N-Pendulum] Solved {n_steps} time steps ({t_end}s) successfully.")
    print(f"[N-Pendulum] Double-click 'n_pendulum.outputs.{output_key}' in the tree to plot.")
    return {"status": "ok", "n_links": N, "n_steps": len(t)}
