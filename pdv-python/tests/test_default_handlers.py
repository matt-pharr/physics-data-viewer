"""
pdv-python/tests/test_default_handlers.py — Tests for built-in
double-click plot handlers in :mod:`pdv.default_handlers`.

These tests run with the matplotlib Agg backend so no windows are ever
opened; we just check that ``dispatch_handler`` runs without error and
that a matplotlib figure was created (or in the 0D/>2D ndarray case,
that a message was printed and no figure was created).
"""

from __future__ import annotations

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

import pytest  # noqa: E402
import numpy as np  # noqa: E402

from pdv.default_handlers import register_defaults  # noqa: E402
from pdv.modules import clear_handlers, dispatch_handler, has_handler_for  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """Clear the handler registry, pin ``plt.show`` to a no-op, and close
    any open figures around each test.

    ``plt.show`` is pinned because :func:`pdv.bootstrap` — exercised by
    other test modules earlier in the run — may globally replace it with
    an inline-capture shim that *closes* the figure after emitting it.
    These tests need figures to persist so they can assert on them, so
    they must not depend on whatever ``plt.show`` happens to be globally.
    """
    clear_handlers()
    plt.close("all")
    monkeypatch.setattr(plt, "show", lambda *args, **kwargs: None)
    yield
    clear_handlers()
    plt.close("all")


def _figure_count() -> int:
    return len(plt.get_fignums())


class TestNdarrayDefault:
    def test_1d_ndarray_plots(self):
        register_defaults()

        arr = np.arange(10, dtype=float)
        result = dispatch_handler(arr, "test.arr1d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        # Title is set to the tree path.
        assert plt.gcf().axes[0].get_title() == "test.arr1d"

    def test_2d_ndarray_plots_imshow_with_colorbar(self):
        register_defaults()

        arr = np.arange(12, dtype=float).reshape(3, 4)
        result = dispatch_handler(arr, "test.arr2d", None)

        assert result == {"dispatched": True}
        # imshow + colorbar produces 2 axes on the figure.
        fig = plt.gcf()
        assert _figure_count() == 1
        assert len(fig.axes) == 2  # image axis + colorbar axis
        # At least one image artist was added.
        assert any(ax.images for ax in fig.axes)
        # The image axis is created first; the title lands on it.
        assert fig.axes[0].get_title() == "test.arr2d"

    def test_object_dtype_ndarray_prints_notice(self, capsys):
        register_defaults()

        arr = np.array([{"x": 1}, {"y": 2}, {"z": 3}], dtype=object)
        result = dispatch_handler(arr, "test.objarr", None)

        # The handler still "dispatched" — it just degraded to a notice
        # instead of raising into dispatch() as an internal.error.
        assert result == {"dispatched": True}
        # The half-built figure was closed, not leaked.
        assert _figure_count() == 0
        assert "[PDV]" in capsys.readouterr().out

    def test_0d_ndarray_prints_notice_no_plot(self, capsys):
        register_defaults()

        arr = np.array(3.14)
        result = dispatch_handler(arr, "test.scalar", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        captured = capsys.readouterr()
        assert "0-D ndarray" in captured.out
        assert "1D and 2D only" in captured.out

    def test_3d_ndarray_prints_notice_no_plot(self, capsys):
        register_defaults()

        arr = np.zeros((2, 3, 4))
        result = dispatch_handler(arr, "test.cube", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        captured = capsys.readouterr()
        assert "3-D ndarray" in captured.out
        assert "shape=(2, 3, 4)" in captured.out


class TestPandasDefault:
    def test_series_plots(self):
        pd = pytest.importorskip("pandas")
        register_defaults()

        s = pd.Series([1.0, 2.0, 3.0, 4.0], name="signal")
        result = dispatch_handler(s, "test.series", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        assert plt.gcf().axes[0].get_title() == "test.series"

    def test_dataframe_plots(self):
        pd = pytest.importorskip("pandas")
        register_defaults()

        df = pd.DataFrame({"a": [1.0, 2.0, 3.0], "b": [4.0, 5.0, 6.0]})
        result = dispatch_handler(df, "test.df", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        # DataFrame.plot() with two numeric columns puts two lines on the axes.
        assert len(plt.gcf().axes[0].lines) == 2

    def test_string_series_prints_notice(self, capsys):
        pd = pytest.importorskip("pandas")
        register_defaults()

        s = pd.Series(["x", "y", "z"], name="labels")
        result = dispatch_handler(s, "test.strseries", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        assert "[PDV]" in capsys.readouterr().out

    def test_dataframe_no_numeric_columns_prints_notice(self, capsys):
        pd = pytest.importorskip("pandas")
        register_defaults()

        df = pd.DataFrame({"a": ["p", "q"], "b": ["r", "s"]})
        result = dispatch_handler(df, "test.strdf", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        assert "[PDV]" in capsys.readouterr().out


class TestXarrayDefault:
    def test_dataarray_1d_plots(self):
        xr = pytest.importorskip("xarray")
        register_defaults()

        da = xr.DataArray(np.arange(8, dtype=float), dims=["x"], name="v")
        result = dispatch_handler(da, "test.da1d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        assert plt.gcf().axes[0].get_title() == "test.da1d"

    def test_dataarray_2d_plots(self):
        xr = pytest.importorskip("xarray")
        register_defaults()

        da = xr.DataArray(
            np.arange(12, dtype=float).reshape(3, 4), dims=["y", "x"], name="image"
        )
        result = dispatch_handler(da, "test.da2d", None)

        assert result == {"dispatched": True}
        # xarray.DataArray.plot() for 2D opens a pcolormesh + colorbar.
        assert _figure_count() == 1
        # The pcolormesh axis is created first; the title lands on it.
        assert plt.gcf().axes[0].get_title() == "test.da2d"

    def test_dataarray_3d_plots_histogram(self):
        xr = pytest.importorskip("xarray")
        register_defaults()

        da = xr.DataArray(np.zeros((2, 3, 4)), dims=["a", "b", "c"], name="cube")
        result = dispatch_handler(da, "test.da3d", None)

        assert result == {"dispatched": True}
        # DataArray.plot() falls back to a histogram for >2D — a real plot,
        # not a notice.
        assert _figure_count() == 1
        assert plt.gcf().axes[0].get_title() == "test.da3d"


class TestComplexArrayDefault:
    def test_1d_complex_plots_re_and_im_lines(self):
        register_defaults()

        arr = np.arange(6, dtype=float) + 1j * np.arange(6, dtype=float)[::-1]
        result = dispatch_handler(arr, "test.c1d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        ax = plt.gcf().axes[0]
        assert ax.get_title() == "test.c1d"
        assert len(ax.get_lines()) == 2
        assert [line.get_label() for line in ax.get_lines()] == ["Re", "Im"]

    def test_2d_complex_plots_re_im_panels_with_own_colorbars(self):
        register_defaults()

        base = np.arange(12, dtype=float).reshape(3, 4)
        arr = base + 1j * (10.0 * base)
        result = dispatch_handler(arr, "test.c2d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        fig = plt.gcf()
        assert fig.get_suptitle() == "test.c2d"
        # Two image panels + one colorbar each = 4 axes total.
        assert len(fig.axes) == 4
        image_axes = [ax for ax in fig.axes if ax.get_images()]
        assert [ax.get_title() for ax in image_axes] == ["Re", "Im"]
        # Own colorbars: the two images carry independent scale limits.
        clims = [ax.get_images()[0].get_clim() for ax in image_axes]
        assert clims[0] == (0.0, 11.0)
        assert clims[1] == (0.0, 110.0)

    def test_3d_complex_prints_notice(self, capsys):
        register_defaults()

        arr = np.zeros((2, 2, 2), dtype=np.complex128)
        result = dispatch_handler(arr, "test.c3d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        assert "Cannot plot 3-D complex ndarray" in capsys.readouterr().out


class TestH5pyDefault:
    def test_1d_dataset_plots(self, tmp_path):
        h5py = pytest.importorskip("h5py")
        register_defaults()

        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("d", data=np.arange(6, dtype=float))
        with h5py.File(tmp_path / "t.h5", "r") as f:
            result = dispatch_handler(f["d"], "test.h5d1", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        assert plt.gcf().axes[0].get_title() == "test.h5d1"

    def test_2d_dataset_plots(self, tmp_path):
        h5py = pytest.importorskip("h5py")
        register_defaults()

        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("d", data=np.zeros((3, 4)))
        with h5py.File(tmp_path / "t.h5", "r") as f:
            result = dispatch_handler(f["d"], "test.h5d2", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1

    def test_1d_complex128_dataset_plots_re_im_lines(self, tmp_path):
        h5py = pytest.importorskip("h5py")
        register_defaults()

        data = np.arange(5, dtype=float) * (1 + 1j)
        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("d", data=data.astype(np.complex128))
        with h5py.File(tmp_path / "t.h5", "r") as f:
            result = dispatch_handler(f["d"], "test.h5c1", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        ax = plt.gcf().axes[0]
        assert [line.get_label() for line in ax.get_lines()] == ["Re", "Im"]

    def test_2d_complex128_dataset_plots_re_im_panels(self, tmp_path):
        h5py = pytest.importorskip("h5py")
        register_defaults()

        data = (np.ones((2, 3)) + 3j * np.ones((2, 3))).astype(np.complex128)
        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("d", data=data)
        with h5py.File(tmp_path / "t.h5", "r") as f:
            result = dispatch_handler(f["d"], "test.h5c2", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        fig = plt.gcf()
        assert fig.get_suptitle() == "test.h5c2"
        image_axes = [ax for ax in fig.axes if ax.get_images()]
        assert [ax.get_title() for ax in image_axes] == ["Re", "Im"]

    def test_3d_dataset_prints_notice(self, tmp_path, capsys):
        h5py = pytest.importorskip("h5py")
        register_defaults()

        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("d", data=np.zeros((2, 2, 2)))
        with h5py.File(tmp_path / "t.h5", "r") as f:
            result = dispatch_handler(f["d"], "test.h5d3", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        out = capsys.readouterr().out
        assert "[PDV] Cannot plot 3-D h5py dataset" in out

    def test_size_cap_prints_notice_without_reading(self, tmp_path, capsys):
        """Datasets over the plot cap print a slicing hint instead of
        being materialized (guards against multi-GB double-clicks)."""
        h5py = pytest.importorskip("h5py")
        from pdv import default_handlers

        register_defaults()

        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("d", data=np.arange(1000, dtype=float))
        with h5py.File(tmp_path / "t.h5", "r") as f:
            # Lower the cap instead of writing a >100 MB fixture.
            orig = default_handlers._H5PY_PLOT_MAX_BYTES
            default_handlers._H5PY_PLOT_MAX_BYTES = 100
            try:
                result = dispatch_handler(f["d"], "test.big", None)
            finally:
                default_handlers._H5PY_PLOT_MAX_BYTES = orig

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        out = capsys.readouterr().out
        assert "Cannot plot 'test.big'" in out
        assert "Slice it in code" in out

    def test_vlen_string_dataset_bails_before_reading(self, tmp_path, capsys):
        """Non-numeric dtypes print the no-plot notice without materializing.

        vlen/object dtypes report itemsize 8 (the pointer, not the payload),
        so the size cap alone would wildly undercount a string dataset and
        read it fully just to fail plotting — the dtype gate must fire first
        (review). The floored cap proves the gate precedes the cap check.
        """
        h5py = pytest.importorskip("h5py")
        from pdv import default_handlers

        register_defaults()
        with h5py.File(tmp_path / "t.h5", "w") as f:
            f.create_dataset("s", data=["alpha", "beta"])
        with h5py.File(tmp_path / "t.h5", "r") as f:
            orig = default_handlers._H5PY_PLOT_MAX_BYTES
            default_handlers._H5PY_PLOT_MAX_BYTES = 1
            try:
                result = dispatch_handler(f["s"], "test.strs", None)
            finally:
                default_handlers._H5PY_PLOT_MAX_BYTES = orig

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        out = capsys.readouterr().out
        assert "No default plot for h5py dataset" in out
        assert "cap" not in out


class TestRegistration:
    def test_handlers_registered_for_present_types(self):
        register_defaults()

        assert has_handler_for(np.zeros(3))

    def test_double_register_suppresses_overwrite_warning(self, recwarn):
        """Re-registering the defaults must not emit the overwrite warning.

        ``pdv.modules.handle`` warns when a handler is overwritten; that
        warning flags user-vs-user conflicts, so ``register_defaults``
        suppresses it for its own re-registration (the documented contract).
        """
        register_defaults()
        register_defaults()  # overwrites the same default handlers

        overwrite = [w for w in recwarn.list if "overwritten" in str(w.message)]
        assert overwrite == []

    def test_user_can_override_default(self):
        register_defaults()

        from pdv.modules import handle  # local import to avoid circulars

        called = {"value": False}

        # The decorator emits a warning when overwriting — silence it so the
        # test doesn't trip on pytest's warning filter.
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")

            @handle(np.ndarray)
            def _user_handler(obj, path, pdv_tree):
                called["value"] = True

        result = dispatch_handler(np.zeros(3), "test.x", None)

        assert result == {"dispatched": True}
        assert called["value"] is True
        # The user's handler ran instead of the default — no figure should
        # have been created.
        assert _figure_count() == 0

    def test_missing_optional_dep_does_not_break_registration(self, monkeypatch):
        """If e.g. xarray is unavailable, the other handlers still register."""
        # Block the xarray import inside _register_xarray and check that
        # ndarray still has a handler afterwards.
        real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __import__

        def fake_import(name, *args, **kwargs):
            if name == "xarray":
                raise ImportError("simulated missing xarray")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", fake_import)
        register_defaults()

        np = sys.modules.get("numpy")
        if np is not None:
            assert has_handler_for(np.zeros(3))


class TestLazyRegistration:
    def test_lookup_registers_defaults_without_explicit_call(self):
        """has_handler_for must self-serve: bootstrap no longer registers
        defaults eagerly (that forced numpy/pandas/xarray imports at kernel
        startup), so the registry lookups lazily register them for any
        library that is already imported."""
        # clear_handlers ran in the fixture; no register_defaults() here.
        assert has_handler_for(np.zeros(3))

    def test_user_handler_wins_over_lazy_default(self):
        """A user handler registered before the lazy default latch fires
        must not be clobbered when the default registers afterwards."""
        from pdv.modules import handle

        calls = []

        @handle(np.ndarray)
        def _user_handler(obj, path, pdv_tree):
            calls.append(path)

        result = dispatch_handler(np.zeros(3), "test.mine", None)
        assert result == {"dispatched": True}
        assert calls == ["test.mine"]
        assert _figure_count() == 0  # default plot handler did NOT run
