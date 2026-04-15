"""Tests for PDVNamelist tree type, namelist_utils, and serialization support."""

from __future__ import annotations

import os
import tempfile
import textwrap

import pytest

from pdv_kernel.tree import PDVNamelist


# ---------------------------------------------------------------------------
# PDVNamelist class tests
# ---------------------------------------------------------------------------


class TestPDVNamelistClass:
    def test_construction_defaults(self):
        node = PDVNamelist("path/to/input.nml")
        assert node.relative_path == "path/to/input.nml"
        assert node.format == "auto"
        assert node.module_id is None

    def test_construction_explicit(self):
        node = PDVNamelist("input.nml", format="fortran", module_id="my_mod")
        assert node.format == "fortran"
        assert node.module_id == "my_mod"

    def test_preview(self):
        node = PDVNamelist("input.nml", format="fortran")
        assert node.preview() == "Namelist (fortran)"

    def test_repr(self):
        node = PDVNamelist("input.nml", format="toml", module_id="m")
        r = repr(node)
        assert "PDVNamelist" in r
        assert "toml" in r
        assert "module_id='m'" in r

    def test_resolve_path_absolute(self):
        node = PDVNamelist("/abs/path/input.nml")
        assert node.resolve_path("/working") == "/abs/path/input.nml"

    def test_resolve_path_relative(self):
        node = PDVNamelist("sub/input.nml")
        assert node.resolve_path("/working") == "/working/sub/input.nml"


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------


class TestDetectFormat:
    def test_fortran_nml(self):
        from pdv_kernel.namelist_utils import detect_namelist_format

        assert detect_namelist_format("solver.nml") == "fortran"

    def test_fortran_in(self):
        from pdv_kernel.namelist_utils import detect_namelist_format

        assert detect_namelist_format("input.in") == "fortran"

    def test_toml(self):
        from pdv_kernel.namelist_utils import detect_namelist_format

        assert detect_namelist_format("config.toml") == "toml"

    def test_unknown(self):
        from pdv_kernel.namelist_utils import detect_namelist_format

        with pytest.raises(ValueError):
            detect_namelist_format("data.csv")


# ---------------------------------------------------------------------------
# Fortran namelist read/write (requires f90nml)
# ---------------------------------------------------------------------------


@pytest.fixture
def fortran_file(tmp_path):
    content = textwrap.dedent("""\
        ! Solver configuration
        &solver_params
            dt = 0.01       ! time step
            n_steps = 1000  ! number of steps
            use_rk4 = .true.
        /

        &grid
            nx = 128
            ny = 256
        /
    """)
    path = tmp_path / "input.nml"
    path.write_text(content)
    return str(path)


class TestFortranNamelist:
    @pytest.fixture(autouse=True)
    def _check_f90nml(self):
        pytest.importorskip("f90nml")

    def test_read_write_roundtrip(self, fortran_file, tmp_path):
        from pdv_kernel.namelist_utils import read_namelist, write_namelist

        data = read_namelist(fortran_file, format="fortran")
        assert "solver_params" in data
        assert data["solver_params"]["dt"] == pytest.approx(0.01)
        assert data["solver_params"]["n_steps"] == 1000
        assert data["solver_params"]["use_rk4"] is True
        assert data["grid"]["nx"] == 128

        out_path = str(tmp_path / "output.nml")
        write_namelist(out_path, data, format="fortran")
        data2 = read_namelist(out_path, format="fortran")
        assert data2["solver_params"]["dt"] == pytest.approx(0.01)
        assert data2["grid"]["ny"] == 256

    def test_extract_hints(self, fortran_file):
        from pdv_kernel.namelist_utils import extract_hints

        hints = extract_hints(fortran_file, format="fortran")
        assert "solver_params" in hints
        assert hints["solver_params"]["dt"] == "time step"
        assert hints["solver_params"]["n_steps"] == "number of steps"

    def test_auto_detect(self, fortran_file):
        from pdv_kernel.namelist_utils import read_namelist

        data = read_namelist(fortran_file, format="auto")
        assert "solver_params" in data


# ---------------------------------------------------------------------------
# TOML read/write
# ---------------------------------------------------------------------------


@pytest.fixture
def toml_file(tmp_path):
    content = textwrap.dedent("""\
        # Global settings
        [solver]
        dt = 0.01       # time step
        n_steps = 1000  # integration steps
        use_rk4 = true

        [grid]
        nx = 128
        ny = 256
    """)
    path = tmp_path / "config.toml"
    path.write_text(content)
    return str(path)


class TestTomlNamelist:
    @pytest.fixture(autouse=True)
    def _check_tomli_w(self):
        pytest.importorskip("tomli_w")

    def test_read_write_roundtrip(self, toml_file, tmp_path):
        from pdv_kernel.namelist_utils import read_namelist, write_namelist

        data = read_namelist(toml_file, format="toml")
        assert data["solver"]["dt"] == pytest.approx(0.01)
        assert data["solver"]["n_steps"] == 1000
        assert data["grid"]["nx"] == 128

        out_path = str(tmp_path / "output.toml")
        write_namelist(out_path, data, format="toml")
        data2 = read_namelist(out_path, format="toml")
        assert data2["solver"]["dt"] == pytest.approx(0.01)
        assert data2["grid"]["ny"] == 256

    def test_extract_hints(self, toml_file):
        from pdv_kernel.namelist_utils import extract_hints

        hints = extract_hints(toml_file, format="toml")
        assert "solver" in hints
        assert hints["solver"]["dt"] == "time step"
        assert hints["solver"]["n_steps"] == "integration steps"


# ---------------------------------------------------------------------------
# Type inference
# ---------------------------------------------------------------------------


class TestInferTypes:
    def test_infer_types(self):
        from pdv_kernel.namelist_utils import infer_types

        data = {
            "group1": {
                "x": 1,
                "y": 2.5,
                "flag": True,
                "name": "test",
                "arr": [1, 2, 3],
            }
        }
        types = infer_types(data)
        assert types["group1"]["x"] == "int"
        assert types["group1"]["y"] == "float"
        assert types["group1"]["flag"] == "bool"
        assert types["group1"]["name"] == "str"
        assert types["group1"]["arr"] == "array"


# ---------------------------------------------------------------------------
# Percent keys (Fortran derived types)
# ---------------------------------------------------------------------------


class TestPercentKeys:
    @pytest.fixture(autouse=True)
    def _check_f90nml(self):
        pytest.importorskip("f90nml")

    def test_percent_key_hint(self, tmp_path):
        content = textwrap.dedent("""\
            &params
                mesh%resolution = 100  ! grid resolution
            /
        """)
        path = tmp_path / "derived.nml"
        path.write_text(content)

        from pdv_kernel.namelist_utils import extract_hints

        hints = extract_hints(str(path), format="fortran")
        assert "params" in hints
        assert hints["params"]["mesh%resolution"] == "grid resolution"


# ---------------------------------------------------------------------------
# Serialization: detect_kind and serialize_node
# ---------------------------------------------------------------------------


class TestSerializationSupport:
    def test_detect_kind_namelist(self):
        from pdv_kernel.serialization import detect_kind, KIND_NAMELIST

        node = PDVNamelist("test.nml", format="fortran")
        assert detect_kind(node) == KIND_NAMELIST

    def test_serialize_namelist_node(self, tmp_path):
        from pdv_kernel.serialization import (
            serialize_node,
            KIND_NAMELIST,
            FORMAT_NAMELIST,
        )

        # Create a source file
        source = tmp_path / "input.nml"
        source.write_text("&test\n  x = 1\n/\n")

        node = PDVNamelist(str(source), format="fortran")
        working_dir = str(tmp_path)
        descriptor = serialize_node("mod.solver_nml", node, working_dir)

        assert descriptor["type"] == KIND_NAMELIST
        assert descriptor["storage"]["format"] == FORMAT_NAMELIST
        assert descriptor["storage"]["backend"] == "local_file"
        assert "relative_path" in descriptor["storage"]
        meta = descriptor["metadata"]
        assert meta["language"] == "namelist"
        assert meta["namelist_format"] == "fortran"
        assert "preview" in meta
