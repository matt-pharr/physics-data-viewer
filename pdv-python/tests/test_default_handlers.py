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
        np = pytest.importorskip("numpy")
        register_defaults()

        arr = np.arange(10, dtype=float)
        result = dispatch_handler(arr, "test.arr1d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        # Title is set to the tree path.
        assert plt.gcf().axes[0].get_title() == "test.arr1d"

    def test_2d_ndarray_plots_imshow_with_colorbar(self):
        np = pytest.importorskip("numpy")
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
        np = pytest.importorskip("numpy")
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
        np = pytest.importorskip("numpy")
        register_defaults()

        arr = np.array(3.14)
        result = dispatch_handler(arr, "test.scalar", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 0
        captured = capsys.readouterr()
        assert "0-D ndarray" in captured.out
        assert "1D and 2D only" in captured.out

    def test_3d_ndarray_prints_notice_no_plot(self, capsys):
        np = pytest.importorskip("numpy")
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
        np = pytest.importorskip("numpy")
        xr = pytest.importorskip("xarray")
        register_defaults()

        da = xr.DataArray(np.arange(8, dtype=float), dims=["x"], name="v")
        result = dispatch_handler(da, "test.da1d", None)

        assert result == {"dispatched": True}
        assert _figure_count() == 1
        assert plt.gcf().axes[0].get_title() == "test.da1d"

    def test_dataarray_2d_plots(self):
        np = pytest.importorskip("numpy")
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
        np = pytest.importorskip("numpy")
        xr = pytest.importorskip("xarray")
        register_defaults()

        da = xr.DataArray(np.zeros((2, 3, 4)), dims=["a", "b", "c"], name="cube")
        result = dispatch_handler(da, "test.da3d", None)

        assert result == {"dispatched": True}
        # DataArray.plot() falls back to a histogram for >2D — a real plot,
        # not a notice.
        assert _figure_count() == 1
        assert plt.gcf().axes[0].get_title() == "test.da3d"


class TestRegistration:
    def test_handlers_registered_for_present_types(self):
        np = pytest.importorskip("numpy")
        register_defaults()

        assert has_handler_for(np.zeros(3))

    def test_double_register_suppresses_overwrite_warning(self, recwarn):
        """Re-registering the defaults must not emit the overwrite warning.

        ``pdv.modules.handle`` warns when a handler is overwritten; that
        warning flags user-vs-user conflicts, so ``register_defaults``
        suppresses it for its own re-registration (the documented contract).
        """
        pytest.importorskip("numpy")
        register_defaults()
        register_defaults()  # overwrites the same default handlers

        overwrite = [w for w in recwarn.list if "overwritten" in str(w.message)]
        assert overwrite == []

    def test_user_can_override_default(self):
        np = pytest.importorskip("numpy")
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
