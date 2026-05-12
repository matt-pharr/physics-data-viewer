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
- ``np.ndarray``: 1D → ``plt.plot``; 2D → ``plt.imshow`` + colorbar;
  0D or >2D → print a notice to stdout, no plot.
- ``pd.Series``: ``series.plot()``.
- ``pd.DataFrame``: ``df.plot()`` (pandas plots all numeric columns vs index).
- ``xr.DataArray``: ``da.plot()`` (xarray auto-dispatches line / pcolormesh /
  facetgrid based on dimensionality).

The path of the tree node is used as the figure title in every case so
the user can tell which node a window belongs to.
"""

from __future__ import annotations

from typing import Any


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


def _register_numpy(handle: Any) -> None:
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError:
        return

    @handle(np.ndarray)
    def _on_ndarray(obj: Any, path: str, pdv_tree: Any) -> None:
        import matplotlib.pyplot as plt  # noqa: PLC0415

        if obj.ndim == 1:
            plt.figure()
            plt.plot(obj)
            plt.title(path)
            plt.show()
        elif obj.ndim == 2:
            plt.figure()
            im = plt.imshow(obj)
            plt.colorbar(im)
            plt.title(path)
            plt.show()
        else:
            print(
                f"[pdv] Cannot plot {obj.ndim}-D ndarray (shape={tuple(obj.shape)}); "
                f"default handler supports 1D and 2D only."
            )


def _register_pandas(handle: Any) -> None:
    try:
        import pandas as pd  # noqa: PLC0415
    except ImportError:
        return

    @handle(pd.Series)
    def _on_series(obj: Any, path: str, pdv_tree: Any) -> None:
        import matplotlib.pyplot as plt  # noqa: PLC0415

        plt.figure()
        obj.plot()
        plt.title(path)
        plt.show()

    @handle(pd.DataFrame)
    def _on_dataframe(obj: Any, path: str, pdv_tree: Any) -> None:
        import matplotlib.pyplot as plt  # noqa: PLC0415

        plt.figure()
        obj.plot(ax=plt.gca())
        plt.title(path)
        plt.show()


def _register_xarray(handle: Any) -> None:
    try:
        import xarray as xr  # noqa: PLC0415
    except ImportError:
        return

    @handle(xr.DataArray)
    def _on_dataarray(obj: Any, path: str, pdv_tree: Any) -> None:
        import matplotlib.pyplot as plt  # noqa: PLC0415

        plt.figure()
        obj.plot()
        plt.title(path)
        plt.show()
