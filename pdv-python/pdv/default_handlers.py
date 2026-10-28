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
        ("h5py", _register_h5py),
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


def _plot_or_notice(
    path: str, draw: Callable[[Any, Any], None], *, ncols: int = 1
) -> None:
    """Create a fresh figure, run ``draw(fig, ax)``, title it, and show it.

    On any failure — whether in ``draw`` or in the final ``plt.show()`` —
    close the figure and print a ``[PDV]`` notice instead of raising:
    handler exceptions would otherwise propagate through ``dispatch_handler``
    and reach the renderer as an opaque ``internal.error``.

    Exactly one figure is created per call, so both inline paths — the
    ``matplotlib-inline`` backend enabled by :mod:`pdv.mpl_config` and its
    legacy ``plt.show()`` shim (which captures ``plt.gcf()``) — always
    resolve to this figure. The success path leaves the figure for
    ``plt.show()`` to own; any failure path closes it.

    Parameters
    ----------
    path : str
        Dot-separated tree path of the node; used as the axes title
        (figure suptitle when ``ncols > 1``).
    draw : Callable[[Figure, Axes], None]
        Callback that draws onto the supplied figure and axes. With
        ``ncols > 1`` the second argument is the ndarray of axes that
        ``plt.subplots(1, ncols)`` returns.
    ncols : int
        Number of side-by-side axes to create (default 1, the historical
        single-axes contract).
    """
    import matplotlib.pyplot as plt  # noqa: PLC0415

    fig, axes = plt.subplots(1, ncols)
    try:
        draw(fig, axes)
        if ncols == 1:
            axes.set_title(path)
        else:
            fig.suptitle(path)
    except Exception as exc:  # noqa: BLE001
        plt.close(fig)
        print(f"[PDV] Cannot plot {path!r}: {exc}")
        return
    try:
        plt.show()
    except Exception as exc:  # noqa: BLE001
        plt.close(fig)
        print(f"[PDV] Could not display {path!r}: {exc}")


def _plot_array_like(obj: Any, path: str, noun: str = "ndarray") -> None:
    """Plot a 1-D array as a line or a 2-D array as an image.

    Shared drawing logic for the ndarray and h5py.Dataset handlers.
    Complex arrays split into real and imaginary parts: 1-D plots Re and
    Im as two labeled lines on one axes; 2-D shows side-by-side Re/Im
    images, each with its own colorbar (the two parts routinely span
    different ranges, so a shared scale would flatten one of them).
    Higher-dimensional arrays print a ``[PDV]`` notice instead.

    Parameters
    ----------
    obj : array-like
        Object with ``ndim``/``shape``/``dtype`` and array semantics.
    path : str
        Dot-separated tree path, used as the plot title.
    noun : str
        Type noun for the can't-plot notice (e.g. ``'h5py dataset'``).
    """
    import numpy as np  # noqa: PLC0415

    if np.iscomplexobj(obj):
        arr = np.asarray(obj)
        if arr.ndim == 1:

            def _draw_lines(fig: Any, ax: Any) -> None:
                ax.plot(arr.real, label="Re")
                ax.plot(arr.imag, label="Im")
                ax.legend()

            _plot_or_notice(path, _draw_lines)
        elif arr.ndim == 2:

            def _draw_panels(fig: Any, axes: Any) -> None:
                ax_re, ax_im = axes
                im_re = ax_re.imshow(arr.real)
                ax_re.set_title("Re")
                fig.colorbar(im_re, ax=ax_re)
                im_im = ax_im.imshow(arr.imag)
                ax_im.set_title("Im")
                fig.colorbar(im_im, ax=ax_im)

            _plot_or_notice(path, _draw_panels, ncols=2)
        else:
            print(
                f"[PDV] Cannot plot {arr.ndim}-D complex {noun} "
                f"(shape={tuple(arr.shape)}); default handler supports "
                f"1D and 2D only."
            )
        return
    if obj.ndim == 1:
        _plot_or_notice(path, lambda fig, ax: ax.plot(obj))
    elif obj.ndim == 2:

        def _draw(fig: Any, ax: Any) -> None:
            im = ax.imshow(obj)
            fig.colorbar(im, ax=ax)

        _plot_or_notice(path, _draw)
    else:
        print(
            f"[PDV] Cannot plot {obj.ndim}-D {noun} (shape={tuple(obj.shape)}); "
            f"default handler supports 1D and 2D only."
        )


def _register_numpy(handle: Any) -> None:
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError:
        return

    @handle(np.ndarray)
    def _on_ndarray(obj: Any, path: str, pdv_tree: Any) -> None:
        _plot_array_like(obj, path)


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


# Materializing an h5py dataset for plotting reads it fully into memory —
# cap it so double-clicking a huge dataset can't freeze the kernel. 1-D/2-D
# arrays beyond this are for slicing in code, not a default line/image plot.
_H5PY_PLOT_MAX_BYTES = 100 * 1024 * 1024


def _register_h5py(handle: Any) -> None:
    try:
        import h5py  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
    except ImportError:
        return

    @handle(h5py.Dataset)
    def _on_h5py_dataset(obj: Any, path: str, pdv_tree: Any) -> None:
        # Only numeric/bool datasets have a default plot — decide from the
        # dtype BEFORE any read. Also load-bearing for the cap: vlen/object
        # dtypes report a bogus 8-byte itemsize (the pointer, not the
        # payload), so the size estimate below would wildly undercount a
        # string dataset and materialize it just to fail plotting (review).
        if not (
            np.issubdtype(obj.dtype, np.number)
            or np.issubdtype(obj.dtype, np.bool_)
        ):
            print(
                f"[PDV] No default plot for h5py dataset at {path!r} "
                f"(dtype {obj.dtype})"
            )
            return
        nbytes = obj.size * obj.dtype.itemsize
        if nbytes > _H5PY_PLOT_MAX_BYTES:
            print(
                f"[PDV] Cannot plot {path!r}: dataset is "
                f"{nbytes / 1e6:.0f} MB (cap "
                f"{_H5PY_PLOT_MAX_BYTES / 1e6:.0f} MB). Slice it in code, "
                f"e.g. pdv_tree[{path!r}][::10]."
            )
            return
        _plot_array_like(np.asarray(obj), path, noun="h5py dataset")
