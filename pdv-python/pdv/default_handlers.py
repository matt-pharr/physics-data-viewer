"""
pdv.default_handlers — Built-in double-click plot handlers for common
scientific Python types.

Registers ``@pdv.handle(...)`` entries so that double-clicking a tree
node whose value is an ``np.ndarray``, ``pd.Series``, ``pd.DataFrame``,
or ``xr.DataArray`` opens a matplotlib window with a sensible default
plot.

Registration is **lazy**: :func:`register_defaults` only registers
handlers for libraries that are already in ``sys.modules``, and the
handler-registry lookups (:func:`pdv.modules.has_handler_for`,
``dispatch_handler``) call it on every lookup. Importing numpy, pandas,
and xarray eagerly at kernel bootstrap cost real startup latency and
undercut the never-import-xarray design in ``serialization.py`` — and a
tree value can only *be* one of these types if its library is already
imported, so the sys.modules gate loses nothing.

Users can override any default by registering their own handler for the
same type in a module. Defaults never overwrite an existing
registration, so a user handler wins regardless of registration order.

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


# Libraries whose defaults have been registered since the last reset.
# Latch so the per-lookup register_defaults() call is a cheap set check.
_lazy_done: set[str] = set()


def register_defaults() -> None:
    """Register built-in plot handlers for every library already imported.

    Called lazily from the handler-registry lookups
    (:func:`pdv.modules.has_handler_for` / ``dispatch_handler``) rather
    than eagerly at kernel bootstrap — see the module docstring for why.
    Checking ``sys.modules`` never triggers an import.

    Never overwrites an existing registration (user handlers win). Safe
    to call any number of times; each library is processed once until
    :func:`pdv.modules.clear_handlers` resets the latch.
    """
    import sys  # noqa: PLC0415

    for lib_name, registrar in (
        ("numpy", _register_numpy),
        ("pandas", _register_pandas),
        ("xarray", _register_xarray),
    ):
        if lib_name in _lazy_done or lib_name not in sys.modules:
            continue
        _lazy_done.add(lib_name)
        registrar(_default_handle)


def _reset_lazy_state() -> None:
    """Forget which libraries' defaults were registered.

    Called by :func:`pdv.modules.clear_handlers` so a registry reset
    (tests, primarily) gets defaults re-registered on the next lookup.
    """
    _lazy_done.clear()


def _default_handle(cls: type) -> Callable:
    """``pdv.handle`` variant for builtin defaults.

    Skips registration when *cls* already has a handler, so a
    user-registered handler for the same type always wins over the
    builtin default — regardless of which registered first.
    """

    def decorator(func: Callable) -> Callable:
        from pdv.modules import _handler_registry, handle  # noqa: PLC0415

        if cls in _handler_registry:
            return func
        return handle(cls)(func)

    return decorator


def _plot_or_notice(path: str, draw: Callable[[Any, Any], None]) -> None:
    """Create a fresh figure, run ``draw(fig, ax)``, title it, and show it.

    On any failure — whether in ``draw`` or in the final ``plt.show()`` —
    close the figure and print a ``[PDV]`` notice instead of raising:
    handler exceptions would otherwise propagate through ``dispatch_handler``
    and reach the renderer as an opaque ``internal.error``.

    Exactly one figure is created per call, so the inline ``plt.show()``
    patch installed by :func:`pdv._configure_matplotlib` (which captures
    ``plt.gcf()``) always resolves to this figure. The success path leaves
    the figure for ``plt.show()`` to own; any failure path closes it.

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
    try:
        plt.show()
    except Exception as exc:  # noqa: BLE001
        plt.close(fig)
        print(f"[PDV] Could not display {path!r}: {exc}")


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
