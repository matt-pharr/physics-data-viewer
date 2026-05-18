"""
pdv.default_handlers — Built-in double-click plot handlers for common
scientific Python types.

Registers ``@pdv.handle(...)`` entries at kernel bootstrap so that
double-clicking a tree node whose value is an ``np.ndarray``,
``pd.Series``, ``pd.DataFrame``, or ``xr.DataArray`` opens a matplotlib
window with a sensible default plot. Registrations are skipped silently
if the corresponding library is not installed.

Users can override any default by registering their own handler for the
same type in a module — ``pdv.handle`` overwrites with a one-line
warning, which is the documented contract.

Behavior summary
----------------
- ``np.ndarray``: 1D → ``ax.plot``; 2D → ``ax.imshow`` + colorbar;
  0D or >2D → print a notice to stdout, no plot.
- ``pd.Series``: ``series.plot()``.
- ``pd.DataFrame``: ``df.plot()`` (pandas plots all numeric columns vs index).
- ``xr.DataArray``: ``da.plot()`` (xarray dispatches 1D → line, 2D →
  pcolormesh, >2D → histogram based on dimensionality).

The path of the tree node is used as the figure title in every case so
the user can tell which node a window belongs to.

If a value cannot actually be plotted (e.g. a non-numeric ``pd.Series``
or an object-dtype array), the handler closes the half-built figure and
prints a ``[PDV]`` notice instead of raising — a raised exception would
surface to the renderer as an opaque ``internal.error`` comm response.
"""

from __future__ import annotations

from typing import Any, Callable


def register_defaults() -> None:
    """Register all built-in plot handlers whose dependencies are installed.

    Called once from :func:`pdv.bootstrap`. Safe to call multiple times —
    ``pdv.handle`` normally warns on overwrite, but the overwrite warning
    is meant to flag user-vs-user conflicts, so it is suppressed here.
    """
    import warnings  # noqa: PLC0415

    from pdv.modules import handle  # noqa: PLC0415

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=r"Handler for .* overwritten.*",
            category=UserWarning,
        )
        _register_numpy(handle)
        _register_pandas(handle)
        _register_xarray(handle)


def _plot_or_notice(path: str, draw: Callable[[Any, Any], None]) -> None:
    """Create a fresh figure, run ``draw(fig, ax)``, title it, and show it.

    On any failure, close the figure and print a ``[PDV]`` notice instead
    of raising — handler exceptions would otherwise propagate through
    ``dispatch_handler`` and reach the renderer as an ``internal.error``.

    Exactly one figure is created per call, so the inline ``plt.show()``
    patch installed by :func:`pdv._configure_matplotlib` (which captures
    ``plt.gcf()``) always resolves to this figure. The success path leaves
    the figure for ``plt.show()`` to own; only the error path closes it.

    Parameters
    ----------
    path : str
        Dot-separated tree path of the node; used as the axes title.
    draw : Callable[[Figure, Axes], None]
        Callback that draws onto the supplied figure and axes.
    """
    import matplotlib.pyplot as plt  # noqa: PLC0415

    fig, ax = plt.subplots()
    try:
        draw(fig, ax)
        ax.set_title(path)
    except Exception as exc:  # noqa: BLE001
        plt.close(fig)
        print(f"[PDV] Cannot plot {path!r}: {exc}")
        return
    plt.show()


def _register_numpy(handle: Any) -> None:
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError:
        return

    @handle(np.ndarray)
    def _on_ndarray(obj: Any, path: str, pdv_tree: Any) -> None:
        if obj.ndim == 1:
            _plot_or_notice(path, lambda fig, ax: ax.plot(obj))
        elif obj.ndim == 2:

            def _draw(fig: Any, ax: Any) -> None:
                im = ax.imshow(obj)
                fig.colorbar(im, ax=ax)

            _plot_or_notice(path, _draw)
        else:
            print(
                f"[PDV] Cannot plot {obj.ndim}-D ndarray (shape={tuple(obj.shape)}); "
                f"default handler supports 1D and 2D only."
            )


def _register_pandas(handle: Any) -> None:
    try:
        import pandas as pd  # noqa: PLC0415
    except ImportError:
        return

    @handle(pd.Series)
    def _on_series(obj: Any, path: str, pdv_tree: Any) -> None:
        _plot_or_notice(path, lambda fig, ax: obj.plot(ax=ax))

    @handle(pd.DataFrame)
    def _on_dataframe(obj: Any, path: str, pdv_tree: Any) -> None:
        _plot_or_notice(path, lambda fig, ax: obj.plot(ax=ax))


def _register_xarray(handle: Any) -> None:
    try:
        import xarray as xr  # noqa: PLC0415
    except ImportError:
        return

    @handle(xr.DataArray)
    def _on_dataarray(obj: Any, path: str, pdv_tree: Any) -> None:
        # xarray's DataArray.plot() dispatches by dimensionality:
        # 1D → line, 2D → pcolormesh, anything else → histogram. All three
        # draw onto the axes passed via ``ax=``.
        _plot_or_notice(path, lambda fig, ax: obj.plot(ax=ax))
