"""
Tests for pdv.add_file() and pdv.new_note() module-level functions.

Covers:
- add_file: copies file to UUID-based storage, returns PDVFile.
- add_file: raises FileNotFoundError for missing source.
- add_file: raises ValueError for directory source.
- add_file: raises PDVError when tree has no working dir.
- add_file: tilde expansion works.
- new_note: creates .md file in UUID storage, attaches to tree.
- new_note: initializes with title header when provided.
- new_note: creates empty file when no title.
- new_note: does nothing when tree is None.
"""

import os
from unittest.mock import patch

import pytest

import pdv
import pdv.comms as comms_mod
from pdv.errors import PDVError
from pdv.tree import PDVFile, PDVNote, PDVTree


class TestAddFile:
    def test_copies_file_and_returns_pdvfile(self, tree_with_comm, tmp_path):
        source = tmp_path / "input.csv"
        source.write_text("a,b,c\n1,2,3\n")

        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_file(str(source))

        assert isinstance(result, PDVFile)
        assert result.filename == "input.csv"
        assert len(result.uuid) == 12

        dest = os.path.join(
            tree_with_comm._working_dir, "tree", result.uuid, "input.csv"
        )
        assert os.path.exists(dest)
        assert open(dest).read() == "a,b,c\n1,2,3\n"

    def test_original_file_not_moved(self, tree_with_comm, tmp_path):
        source = tmp_path / "keep_me.txt"
        source.write_text("original")

        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            pdv.add_file(str(source))

        assert source.exists()
        assert source.read_text() == "original"

    def test_binary_file_preserved(self, tree_with_comm, tmp_path):
        source = tmp_path / "data.bin"
        binary_data = bytes(range(256))
        source.write_bytes(binary_data)

        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_file(str(source))

        dest = os.path.join(
            tree_with_comm._working_dir, "tree", result.uuid, "data.bin"
        )
        assert open(dest, "rb").read() == binary_data

    def test_raises_for_missing_source(self, tree_with_comm):
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            pytest.raises(FileNotFoundError, match="not found"),
        ):
            pdv.add_file("/no/such/file.txt")

    def test_raises_for_directory_source(self, tree_with_comm, tmp_path):
        dir_path = tmp_path / "some_dir"
        dir_path.mkdir()

        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            pytest.raises(ValueError, match="not a file"),
        ):
            pdv.add_file(str(dir_path))

    def test_raises_when_no_working_dir(self, tmp_path):
        source = tmp_path / "exists.txt"
        source.write_text("data")
        tree = PDVTree()
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree),
            pytest.raises(PDVError, match="not available"),
        ):
            pdv.add_file(str(source))

    def test_tilde_expansion(self, tree_with_comm, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        source = tmp_path / "doc.txt"
        source.write_text("hello")

        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_file("~/doc.txt")

        assert isinstance(result, PDVFile)
        assert result.filename == "doc.txt"


class TestNewNote:
    def test_creates_note_in_tree(self, tree_with_comm):
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            pdv.new_note("notes.intro", title="Introduction")

        note = tree_with_comm["notes.intro"]
        assert isinstance(note, PDVNote)
        assert note.filename == "intro.md"
        assert note.title == "Introduction"
        assert len(note.uuid) == 12

    def test_file_initialized_with_title_header(self, tree_with_comm):
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            pdv.new_note("notes.physics", title="Physics Notes")

        note = tree_with_comm["notes.physics"]
        file_path = os.path.join(
            tree_with_comm._working_dir, "tree", note.uuid, "physics.md"
        )
        assert os.path.exists(file_path)
        content = open(file_path, encoding="utf-8").read()
        assert content == "# Physics Notes\n"

    def test_file_empty_when_no_title(self, tree_with_comm):
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            pdv.new_note("notes.blank")

        note = tree_with_comm["notes.blank"]
        file_path = os.path.join(
            tree_with_comm._working_dir, "tree", note.uuid, "blank.md"
        )
        assert os.path.exists(file_path)
        content = open(file_path, encoding="utf-8").read()
        assert content == ""

    def test_noop_when_tree_is_none(self, capsys):
        with patch.object(comms_mod, "get_pdv_tree", return_value=None):
            pdv.new_note("notes.ghost", title="Ghost")

        captured = capsys.readouterr()
        assert "not initialized" in captured.out

    def test_nested_path_creates_intermediate_folders(self, tree_with_comm):
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            pdv.new_note("docs.section.intro", title="Intro")

        note = tree_with_comm["docs.section.intro"]
        assert isinstance(note, PDVNote)

    def test_prints_confirmation(self, tree_with_comm, capsys):
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            pdv.new_note("notes.hello", title="Hello")

        captured = capsys.readouterr()
        assert "notes.hello" in captured.out


class TestAddFileAutodetect:
    """Extension auto-detection for scientific data files (issue #203)."""

    def test_nc_extension_returns_pdvdataset(self, tree_with_comm, tmp_path):
        from pdv.tree import PDVDataset

        source = tmp_path / "gpec_output.nc"
        source.write_bytes(b"not a real netcdf, detection is by extension")
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_file(str(source))
        assert isinstance(result, PDVDataset)
        assert result.filename == "gpec_output.nc"

    def test_h5_extensions_return_pdvhdf5(self, tree_with_comm, tmp_path):
        from pdv.tree import PDVHdf5

        for name in ("efit.h5", "run.hdf5"):
            source = tmp_path / name
            source.write_bytes(b"detection is by extension")
            with patch.object(
                comms_mod, "get_pdv_tree", return_value=tree_with_comm
            ):
                result = pdv.add_file(str(source))
            assert isinstance(result, PDVHdf5), name

    def test_case_insensitive_extension(self, tree_with_comm, tmp_path):
        from pdv.tree import PDVDataset

        source = tmp_path / "DATA.NC"
        source.write_bytes(b"x")
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_file(str(source))
        assert isinstance(result, PDVDataset)

    def test_other_extension_stays_plain_pdvfile(self, tree_with_comm, tmp_path):
        from pdv.tree import PDVDataset, PDVHdf5

        source = tmp_path / "notes.txt"
        source.write_text("hello")
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_file(str(source))
        assert isinstance(result, PDVFile)
        assert not isinstance(result, (PDVDataset, PDVHdf5))


class TestAddDatasetAddHdf5:
    """Explicit typed-import functions with dep-check-before-copy."""

    def test_add_dataset_forces_type_regardless_of_extension(
        self, tree_with_comm, tmp_path
    ):
        from pdv.tree import PDVDataset

        if PDVDataset._missing_deps():
            pytest.skip("xarray/netcdf backend not installed")
        source = tmp_path / "gpec.out"  # odd extension
        source.write_bytes(b"x")
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_dataset(str(source))
        assert isinstance(result, PDVDataset)
        assert os.path.exists(
            os.path.join(
                tree_with_comm._working_dir, "tree", result.uuid, "gpec.out"
            )
        )

    def test_add_hdf5_forces_type(self, tree_with_comm, tmp_path):
        from pdv.tree import PDVHdf5

        if PDVHdf5._missing_deps():
            pytest.skip("h5py not installed")
        source = tmp_path / "geqdsk.dat"
        source.write_bytes(b"x")
        with patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm):
            result = pdv.add_hdf5(str(source))
        assert isinstance(result, PDVHdf5)

    def test_add_dataset_dep_check_fires_before_copy(
        self, tree_with_comm, tmp_path
    ):
        """A missing dependency must fail fast — before the (potentially
        multi-GB) file copy happens."""
        from pdv.tree import PDVDataset

        source = tmp_path / "big.nc"
        source.write_bytes(b"x")
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            patch.object(
                PDVDataset, "_missing_deps", return_value=["xarray", "netcdf4"]
            ),
        ):
            with pytest.raises(PDVError) as excinfo:
                pdv.add_dataset(str(source))
        assert "pdv.install('xarray', 'netcdf4')" in str(excinfo.value)
        # No copy happened: the working dir's tree/ has no new entries.
        tree_root = os.path.join(tree_with_comm._working_dir, "tree")
        assert not os.path.exists(tree_root) or os.listdir(tree_root) == []

    def test_add_hdf5_dep_check_fires_before_copy(
        self, tree_with_comm, tmp_path
    ):
        from pdv.tree import PDVHdf5

        source = tmp_path / "big.h5"
        source.write_bytes(b"x")
        with (
            patch.object(comms_mod, "get_pdv_tree", return_value=tree_with_comm),
            patch.object(PDVHdf5, "_missing_deps", return_value=["h5py"]),
        ):
            with pytest.raises(PDVError) as excinfo:
                pdv.add_hdf5(str(source))
        assert "pdv-python[hdf5]" in str(excinfo.value)
        tree_root = os.path.join(tree_with_comm._working_dir, "tree")
        assert not os.path.exists(tree_root) or os.listdir(tree_root) == []
