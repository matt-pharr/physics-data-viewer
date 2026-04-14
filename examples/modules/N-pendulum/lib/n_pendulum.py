"""
n_pendulum — Custom types and handlers for the N-Pendulum PDV module.

Defines the ``PendulumSolution`` custom data type and registers a
double-click handler that produces a quick overview plot (trajectory +
angle time series) when the user double-clicks a solution node in the tree.

This module is imported automatically by the kernel during module setup
via the ``entry_point`` field in ``pdv-module.json``.
"""

from __future__ import annotations

import json

import numpy as np
from pdv_kernel import register_serializer
from pdv_kernel.modules import handle


class PendulumSolution:
    """Solution of an N-link pendulum ODE integration.

    Stored as a single tree node by ``solve.py``.  Double-clicking the node
    in the tree invokes the registered handler which plots the solution.

    Attributes
    ----------
    t : ndarray, shape (n_steps,)
        Time array.
    thetas : ndarray, shape (N, n_steps)
        Joint angles in radians.
    omegas : ndarray, shape (N, n_steps)
        Angular velocities in rad/s.
    xs : ndarray, shape (N, n_steps)
        Cartesian x-coordinates of each bob.
    ys : ndarray, shape (N, n_steps)
        Cartesian y-coordinates of each bob.
    params : dict
        Solver parameters used to produce the solution.
    """

    def __init__(
        self,
        t: np.ndarray,
        thetas: np.ndarray,
        omegas: np.ndarray,
        xs: np.ndarray,
        ys: np.ndarray,
        params: dict,
    ):
        self.t = t
        self.thetas = thetas
        self.omegas = omegas
        self.xs = xs
        self.ys = ys
        self.params = params

    @property
    def n_links(self) -> int:
        return int(self.params["N"])

    @property
    def n_steps(self) -> int:
        return len(self.t)

    def preview(self) -> str:
        """Short description for the tree panel."""
        names = {1: "single", 2: "double", 3: "triple", 4: "quadruple"}
        label = names.get(self.n_links, f"{self.n_links}-link")
        return f"{label} pendulum ({self.n_steps} steps, {self.t[-1]:.1f}s)"

    def __repr__(self) -> str:
        return (
            f"PendulumSolution(n_links={self.n_links}, "
            f"n_steps={self.n_steps}, t_end={self.t[-1]:.1f}s)"
        )


def _save_pendulum_solution(sol: "PendulumSolution", path: str) -> None:
    """Write a PendulumSolution to a single ``.npz`` file.

    Demonstrates the ``pdv.register_serializer`` hook: PDV chooses ``path``
    and this callback only has to dump the object's state into it.
    """
    np.savez(
        path,
        t=sol.t,
        thetas=sol.thetas,
        omegas=sol.omegas,
        xs=sol.xs,
        ys=sol.ys,
        params_json=np.array(json.dumps(sol.params)),
    )


def _load_pendulum_solution(path: str) -> "PendulumSolution":
    """Reconstruct a PendulumSolution from the ``.npz`` written above."""
    data = np.load(path, allow_pickle=False)
    return PendulumSolution(
        t=data["t"],
        thetas=data["thetas"],
        omegas=data["omegas"],
        xs=data["xs"],
        ys=data["ys"],
        params=json.loads(str(data["params_json"])),
    )


register_serializer(
    PendulumSolution,
    format="n_pendulum_solution_v1",
    extension=".npz",
    save=_save_pendulum_solution,
    load=_load_pendulum_solution,
    preview=lambda sol: sol.preview(),
)


@handle(PendulumSolution)
def plot_pendulum(sol: PendulumSolution, path: str, pdv_tree: dict) -> None:
    """Quick overview plot: final-bob trajectory + angle time series.

    Invoked when the user double-clicks a ``PendulumSolution`` node in the
    tree.  Opens an interactive Qt window with two panels.
    """
    import matplotlib
    matplotlib.use("Qt5Agg")  # PyQt6 is served via the Qt5Agg shim
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    N = sol.n_links
    names = {1: "Single", 2: "Double", 3: "Triple", 4: "Quadruple"}
    title = f"{names.get(N, str(N) + '-Link')} Pendulum"

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    fig.suptitle(title, fontsize=14, fontweight="bold")

    # --- Panel 1: Final-bob trajectory coloured by time ---
    xN, yN = sol.xs[-1], sol.ys[-1]
    colors = plt.cm.viridis(np.linspace(0, 1, sol.n_steps))
    points = np.column_stack([xN, yN]).reshape(-1, 1, 2)
    segments = np.concatenate([points[:-1], points[1:]], axis=1)
    lc = LineCollection(segments, colors=colors[:-1], linewidths=0.8)
    ax1.add_collection(lc)
    pad = 0.2
    ax1.set_xlim(xN.min() - pad, xN.max() + pad)
    ax1.set_ylim(yN.min() - pad, yN.max() + pad)
    ax1.set_aspect("equal")
    ax1.set_xlabel(f"x{N}")
    ax1.set_ylabel(f"y{N}")
    ax1.set_title(f"Bob {N} trajectory")

    # --- Panel 2: Angle time series for all links ---
    for i in range(N):
        ax2.plot(sol.t, np.degrees(sol.thetas[i]), linewidth=0.8,
                 label=f"\u03b8{i + 1}")
    ax2.set_xlabel("Time (s)")
    ax2.set_ylabel("Angle (\u00b0)")
    ax2.set_title("Angles vs time")
    ax2.legend(fontsize=8)

    fig.tight_layout()
    plt.show()
    print(f"[N-Pendulum] Plotted solution at '{path}'")
