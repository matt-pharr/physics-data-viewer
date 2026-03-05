"""
animate.py — Visualise the N-link pendulum solution.

Produces a multi-panel figure:
  1. Phase-space trajectory of the final bob (x_N vs y_N).
  2. Time series of all link angles.
  3. Overlay of sampled arm configurations colour-coded by time.

Uses the Qt6Agg backend (PyQt6) by default so the plot window is
interactive.
"""

import numpy as np
import matplotlib
matplotlib.use("Qt5Agg")  # PyQt6 is served via the Qt5Agg shim
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection


def run(
    pdv_tree: dict,
    animate_output_key: str = "result",
    render_style: str = "trajectory",
    n_frames: int = 200,
    trail_alpha: float = 0.15,
    show_legend: bool = True,
    output_dir: str = "",
) -> dict:
    # ------------------------------------------------------------------
    # Pull solution data from tree
    # ------------------------------------------------------------------
    output_key = str(animate_output_key).strip()
    if not output_key:
        raise ValueError("animate_output_key must be a non-empty string")
    style = str(render_style).strip().lower()
    if style not in {"trajectory", "angles"}:
        raise ValueError("render_style must be one of: trajectory, angles")
    n_frames = int(n_frames)
    trail_alpha = float(trail_alpha)
    show_legend = bool(show_legend)
    output_dir = str(output_dir).strip()
    if n_frames < 1:
        raise ValueError("n_frames must be at least 1")
    if trail_alpha < 0.0 or trail_alpha > 1.0:
        raise ValueError("trail_alpha must be between 0.0 and 1.0")
    root = f"n_pendulum.{output_key}"
    try:
        t      = pdv_tree[f"{root}.t"]
        xs     = pdv_tree[f"{root}.xs"]      # (N, n_steps)
        ys     = pdv_tree[f"{root}.ys"]      # (N, n_steps)
        thetas = pdv_tree[f"{root}.thetas"]   # (N, n_steps)
        params = pdv_tree[f"{root}.params"]
    except (KeyError, Exception):
        raise RuntimeError(
            f"No solution data found at '{root}'. Run the ODE solver first."
        )

    N = int(params["N"])
    lengths = np.array(params["lengths"])
    total_L = float(np.sum(lengths))
    n_pts = len(t)
    n_frames = min(n_frames, n_pts)
    frame_idx = np.linspace(0, n_pts - 1, n_frames, dtype=int)

    names = {1: "Single", 2: "Double", 3: "Triple", 4: "Quadruple"}
    title = f"{names.get(N, str(N) + '-Link')} Pendulum"

    # ------------------------------------------------------------------
    # Figure layout: 3 panels
    # ------------------------------------------------------------------
    fig, axes = plt.subplots(1, 3, figsize=(17, 5.5),
                             gridspec_kw={"width_ratios": [1, 1, 1.2]})
    fig.suptitle(title, fontsize=14, fontweight="bold", y=0.98)

    # --- Panel 1: Phase portrait of the final bob ---
    ax1 = axes[0]
    if style == "trajectory":
        xN = xs[-1]
        yN = ys[-1]
        colors = plt.cm.viridis(np.linspace(0, 1, n_pts))
        points = np.column_stack([xN, yN]).reshape(-1, 1, 2)
        segments = np.concatenate([points[:-1], points[1:]], axis=1)
        lc = LineCollection(segments, colors=colors[:-1], linewidths=0.6)
        ax1.add_collection(lc)
        pad = 0.2
        ax1.set_xlim(xN.min() - pad, xN.max() + pad)
        ax1.set_ylim(yN.min() - pad, yN.max() + pad)
        ax1.set_aspect("equal")
        ax1.set_xlabel(f"x{N}")
        ax1.set_ylabel(f"y{N}")
        ax1.set_title(f"Bob {N} trajectory")
    else:
        ax1.axis("off")
        ax1.text(0.5, 0.5, "Trajectory hidden\n(render_style=angles)",
                 ha="center", va="center", fontsize=10, transform=ax1.transAxes)

    # --- Panel 2: Angle time series for all links ---
    ax2 = axes[1]
    for i in range(N):
        ax2.plot(t, np.degrees(thetas[i]), linewidth=0.7,
                 label=f"theta{i + 1}")
    ax2.set_xlabel("Time (s)")
    ax2.set_ylabel("Angle (deg)")
    ax2.set_title("Angles vs time")
    if show_legend:
        ax2.legend(fontsize=8, ncol=max(1, N // 3))

    # --- Panel 3: Arm position overlay (sampled frames) ---
    ax3 = axes[2]
    if style == "trajectory":
        ax3.set_xlim(-total_L * 1.15, total_L * 1.15)
        ax3.set_ylim(-total_L * 1.15, total_L * 0.5)
        ax3.set_aspect("equal")
        ax3.set_title("Arm positions (sampled)")

        for fi, idx in enumerate(frame_idx):
            frac = fi / max(n_frames - 1, 1)
            alpha = trail_alpha + (1.0 - trail_alpha) * frac
            color = plt.cm.plasma(frac)

            # Build polyline: pivot (0,0) -> bob1 -> bob2 -> ... -> bobN
            arm_x = np.zeros(N + 1)
            arm_y = np.zeros(N + 1)
            for i in range(N):
                arm_x[i + 1] = xs[i][idx]
                arm_y[i + 1] = ys[i][idx]

            ax3.plot(arm_x, arm_y, "-o", color=color, alpha=alpha,
                     linewidth=0.6, markersize=2)

        ax3.plot(0, 0, "ks", markersize=6, zorder=5)  # pivot marker
    else:
        ax3.axis("off")
        ax3.text(0.5, 0.5, "Arm overlay hidden\n(render_style=angles)",
                 ha="center", va="center", fontsize=10, transform=ax3.transAxes)

    fig.tight_layout()
    plt.show()

    print(f"[N-Pendulum] Plotted {n_frames} frames for {N}-link pendulum.")
    return {"status": "ok", "n_frames": n_frames, "render_style": style, "output_dir": output_dir}
