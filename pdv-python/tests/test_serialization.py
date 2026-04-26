"""
pdv-python/tests/test_serialization.py — Unit tests for pdv.serialization.

Tests cover:
1. detect_kind() for all supported types.
2. serialize_node() for each format: npy, parquet, json, txt, pickle.
3. deserialize_node() round-trips for each format.
4. node_preview() for representative values.
5. metadata sub-dict present and correct for all node kinds.

Reference: ARCHITECTURE.md §7.2, §7.3
"""

import os
import pytest
from pdv.serialization import (
    detect_kind,
    serialize_node,
    deserialize_node,
    node_preview,
    KIND_NDARRAY,
    KIND_DATAFRAME,
    KIND_SERIES,
    KIND_SCALAR,
    KIND_TEXT,
    KIND_MAPPING,
    KIND_SEQUENCE,
    KIND_FOLDER,
    KIND_SCRIPT,
    KIND_FILE,
    KIND_UNKNOWN,
    FORMAT_FILE,
)
from pdv.errors import PDVSerializationError


class WeirdPicklable:
    """Module-level class so pickle can locate it during round-trip tests."""

    pass


class TestDetectKind:
    """Tests for detect_kind()."""

    def test_int_is_scalar(self):
        assert detect_kind(42) == KIND_SCALAR

    def test_float_is_scalar(self):
        assert detect_kind(3.14) == KIND_SCALAR

    def test_none_is_scalar(self):
        assert detect_kind(None) == KIND_SCALAR

    def test_bool_is_scalar(self):
        # bool is a subclass of int; must still map to scalar
        assert detect_kind(True) == KIND_SCALAR

    def test_str_is_text(self):
        assert detect_kind("hello") == KIND_TEXT

    def test_dict_is_mapping(self):
        assert detect_kind({"a": 1}) == KIND_MAPPING

    def test_list_is_sequence(self):
        assert detect_kind([1, 2, 3]) == KIND_SEQUENCE

    def test_tuple_is_sequence(self):
        assert detect_kind((1, 2)) == KIND_SEQUENCE

    def test_bytes_is_binary(self):
        from pdv.serialization import KIND_BINARY

        assert detect_kind(b"data") == KIND_BINARY

    def test_numpy_array_is_ndarray(self):
        """numpy array returns KIND_NDARRAY (skipped if numpy absent)."""
        numpy = pytest.importorskip("numpy")
        assert detect_kind(numpy.array([1.0, 2.0])) == KIND_NDARRAY

    def test_pandas_dataframe_is_dataframe(self):
        """DataFrame returns KIND_DATAFRAME (skipped if pandas absent)."""
        pandas = pytest.importorskip("pandas")
        assert detect_kind(pandas.DataFrame({"a": [1, 2]})) == KIND_DATAFRAME

    def test_pandas_series_is_series(self):
        """Series returns KIND_SERIES (skipped if pandas absent)."""
        pandas = pytest.importorskip("pandas")
        assert detect_kind(pandas.Series([1, 2, 3])) == KIND_SERIES

    def test_unknown_object(self):
        """An arbitrary object returns KIND_UNKNOWN."""
        assert detect_kind(WeirdPicklable()) == KIND_UNKNOWN

    def test_pdv_tree_is_folder(self):
        """PDVTree returns KIND_FOLDER."""
        from pdv.tree import PDVTree

        assert detect_kind(PDVTree()) == KIND_FOLDER

    def test_pdv_script_is_script(self):
        """PDVScript returns KIND_SCRIPT."""
        from pdv.tree import PDVScript

        assert detect_kind(PDVScript("abc123def456", "test.py")) == KIND_SCRIPT


class TestSerializeAndDeserialize:
    """Round-trip tests for serialize_node() + deserialize_node()."""

    def test_scalar_json_roundtrip(self, tmp_working_dir):
        descriptor = serialize_node("x", 42, tmp_working_dir)
        assert descriptor["type"] == KIND_SCALAR
        assert descriptor["storage"]["backend"] == "inline"
        value = deserialize_node(descriptor["storage"], tmp_working_dir)
        assert value == 42

    def test_text_roundtrip(self, tmp_working_dir):
        descriptor = serialize_node("t", "hello world", tmp_working_dir)
        assert descriptor["type"] == KIND_TEXT
        value = deserialize_node(descriptor["storage"], tmp_working_dir)
        assert value == "hello world"

    def test_mapping_json_roundtrip(self, tmp_working_dir):
        data = {"key": "val", "num": 7}
        descriptor = serialize_node("m", data, tmp_working_dir)
        assert descriptor["type"] == KIND_MAPPING
        value = deserialize_node(descriptor["storage"], tmp_working_dir)
        assert value == data

    def test_sequence_roundtrip(self, tmp_working_dir):
        data = [1, 2, 3]
        descriptor = serialize_node("s", data, tmp_working_dir)
        assert descriptor["type"] == KIND_SEQUENCE
        value = deserialize_node(descriptor["storage"], tmp_working_dir)
        assert value == data

    def test_numpy_npy_roundtrip(self, tmp_working_dir):
        """numpy array → npy file → back to array (pytest.importorskip)."""
        numpy = pytest.importorskip("numpy")
        arr = numpy.array([[1.0, 2.0], [3.0, 4.0]])
        descriptor = serialize_node("data.arr", arr, tmp_working_dir)
        assert descriptor["type"] == KIND_NDARRAY
        assert descriptor["storage"]["format"] == "npy"
        value = deserialize_node(descriptor["storage"], tmp_working_dir)
        assert numpy.array_equal(value, arr)

    def test_pandas_dataframe_parquet_roundtrip(self, tmp_working_dir):
        """DataFrame → parquet → back to DataFrame (pytest.importorskip)."""
        pandas = pytest.importorskip("pandas")
        pytest.importorskip("pyarrow")
        df = pandas.DataFrame({"a": [1, 2, 3], "b": [4.0, 5.0, 6.0]})
        descriptor = serialize_node("data.df", df, tmp_working_dir)
        assert descriptor["type"] == KIND_DATAFRAME
        assert descriptor["storage"]["format"] == "parquet"
        value = deserialize_node(descriptor["storage"], tmp_working_dir)
        assert list(value["a"]) == [1, 2, 3]

    def test_unknown_raises_without_trusted(self, tmp_working_dir):
        """serialize_node() raises PDVSerializationError for unknown type without trusted=True."""
        with pytest.raises(PDVSerializationError):
            serialize_node("u", WeirdPicklable(), tmp_working_dir)

    def test_unknown_pickle_roundtrip_trusted(self, tmp_working_dir):
        """serialize_node() with trusted=True pickles unknown types."""
        obj = WeirdPicklable()
        descriptor = serialize_node("u", obj, tmp_working_dir, trusted=True)
        assert descriptor["storage"]["format"] == "pickle"
        restored = deserialize_node(
            descriptor["storage"], tmp_working_dir, trusted=True
        )
        assert isinstance(restored, WeirdPicklable)

    def test_pickle_raises_without_trusted(self, tmp_working_dir):
        """deserialize_node raises for pickle format without trusted=True."""
        descriptor = serialize_node(
            "u", WeirdPicklable(), tmp_working_dir, trusted=True
        )
        with pytest.raises(PDVSerializationError):
            deserialize_node(descriptor["storage"], tmp_working_dir, trusted=False)

    def test_descriptor_fields_present(self, tmp_working_dir):
        """Returned descriptor contains all required fields including metadata."""
        descriptor = serialize_node("my.node", 123, tmp_working_dir)
        required = {
            "id",
            "path",
            "key",
            "parent_path",
            "type",
            "has_children",
            "created_at",
            "updated_at",
            "storage",
            "metadata",
        }
        assert required.issubset(descriptor.keys())
        assert descriptor["id"] == "my.node"
        assert descriptor["key"] == "node"
        assert descriptor["parent_path"] == "my"
        assert "preview" in descriptor["metadata"]


class TestNodePreview:
    """Tests for node_preview()."""

    def test_scalar_preview(self):
        assert node_preview(42, KIND_SCALAR) == "42"

    def test_text_preview_truncates(self):
        long_text = "x" * 100
        preview = node_preview(long_text, KIND_TEXT)
        assert len(preview) <= 100
        assert "..." in preview

    def test_text_short_no_truncation(self):
        short = "hello"
        assert node_preview(short, KIND_TEXT) == "hello"

    def test_ndarray_preview(self):
        numpy = pytest.importorskip("numpy")
        arr = numpy.array([[1.0, 2.0], [3.0, 4.0]])
        preview = node_preview(arr, KIND_NDARRAY)
        assert "array" in preview.lower() or "float" in preview.lower()

    def test_mapping_preview(self):
        preview = node_preview({"a": 1, "b": 2}, KIND_MAPPING)
        assert "dict" in preview.lower()

    def test_sequence_preview(self):
        preview = node_preview([1, 2, 3], KIND_SEQUENCE)
        assert "list" in preview.lower()


class TestMetadataSubDict:
    """Tests that all descriptors contain a metadata sub-dict with type-specific fields."""

    def test_module_descriptor_metadata(self, tmp_working_dir):
        from pdv.tree import PDVModule

        mod = PDVModule(module_id="test_mod", name="Test Module", version="1.0.0")
        desc = serialize_node("mymod", mod, tmp_working_dir)
        assert "metadata" in desc
        meta = desc["metadata"]
        assert meta["module_id"] == "test_mod"
        assert meta["name"] == "Test Module"
        assert meta["version"] == "1.0.0"
        assert "preview" in meta

    def test_gui_descriptor_metadata(self, tmp_working_dir):
        from pdv.tree import PDVGui

        node_uuid = "gui_uuid_001"
        gui_file = os.path.join(tmp_working_dir, "tree", node_uuid, "gui.gui.json")
        os.makedirs(os.path.dirname(gui_file), exist_ok=True)
        with open(gui_file, "w") as f:
            f.write("{}")
        gui = PDVGui(uuid=node_uuid, filename="gui.gui.json", module_id="test_mod")
        desc = serialize_node("mod.gui", gui, tmp_working_dir)
        assert "metadata" in desc
        meta = desc["metadata"]
        assert meta["module_id"] == "test_mod"
        assert "preview" in meta

    def test_namelist_descriptor_metadata(self, tmp_working_dir):
        from pdv.tree import PDVNamelist

        node_uuid = "nml_uuid_001"
        nml_file = os.path.join(tmp_working_dir, "tree", node_uuid, "solver.nml")
        os.makedirs(os.path.dirname(nml_file), exist_ok=True)
        with open(nml_file, "w") as f:
            f.write("&solver /\n")
        nml = PDVNamelist(
            uuid=node_uuid, filename="solver.nml", format="fortran", module_id="test_mod"
        )
        desc = serialize_node("mod.solver", nml, tmp_working_dir)
        assert "metadata" in desc
        meta = desc["metadata"]
        assert meta["module_id"] == "test_mod"
        assert meta["namelist_format"] == "fortran"
        assert "preview" in meta

    def test_lib_descriptor_metadata(self, tmp_working_dir):
        from pdv.tree import PDVLib

        node_uuid = "lib_uuid_001"
        lib_file = os.path.join(tmp_working_dir, "tree", node_uuid, "helpers.py")
        os.makedirs(os.path.dirname(lib_file), exist_ok=True)
        with open(lib_file, "w") as f:
            f.write("# helpers\n")
        lib = PDVLib(uuid=node_uuid, filename="helpers.py", module_id="test_mod")
        desc = serialize_node("mod.lib.helpers", lib, tmp_working_dir)
        assert "metadata" in desc
        meta = desc["metadata"]
        assert meta["module_id"] == "test_mod"
        assert meta["language"] == "python"
        assert "preview" in meta

    def test_script_descriptor_metadata(self, tmp_working_dir):
        from pdv.tree import PDVScript

        node_uuid = "scr_uuid_001"
        script_file = os.path.join(tmp_working_dir, "tree", node_uuid, "run.py")
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, "w") as f:
            f.write('"""My script."""\ndef run(pdv_tree: dict):\n    return {}\n')
        script = PDVScript(
            uuid=node_uuid, filename="run.py", language="python", doc="My script."
        )
        desc = serialize_node("run", script, tmp_working_dir)
        assert "metadata" in desc
        meta = desc["metadata"]
        assert meta["language"] == "python"
        assert meta["doc"] == "My script."
        assert "preview" in meta
        # Non-module scripts do not carry source_rel_path.
        assert "source_rel_path" not in desc

    def test_module_owned_script_carries_source_rel_path(self, tmp_working_dir):
        """PDVScript with source_rel_path set round-trips through serialize_node."""
        from pdv.tree import PDVScript

        node_uuid = "mod_scr_001"
        script_file = os.path.join(tmp_working_dir, "tree", node_uuid, "run.py")
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, "w") as f:
            f.write('"""Module script."""\ndef run(pdv_tree: dict):\n    return {}\n')
        script = PDVScript(
            uuid=node_uuid,
            filename="run.py",
            language="python",
            doc="Module script.",
            module_id="my_mod",
            source_rel_path="scripts/run.py",
        )
        desc = serialize_node("my_mod.scripts.run", script, tmp_working_dir)
        assert desc["source_rel_path"] == "scripts/run.py"

    def test_source_rel_path_round_trip_through_tree_loader(self, tmp_working_dir):
        """serialize_node + load_tree_index preserve source_rel_path across save/load."""
        from pdv.tree import PDVLib, PDVModule, PDVScript, PDVTree
        from pdv.tree_loader import load_tree_index

        scr_uuid = "mod_scr_rt01"
        lib_uuid = "mod_lib_rt01"
        script_dir = os.path.join(tmp_working_dir, "tree", scr_uuid)
        lib_dir = os.path.join(tmp_working_dir, "tree", lib_uuid)
        os.makedirs(script_dir, exist_ok=True)
        os.makedirs(lib_dir, exist_ok=True)
        script_file = os.path.join(script_dir, "run.py")
        with open(script_file, "w") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")
        lib_file = os.path.join(lib_dir, "helpers.py")
        with open(lib_file, "w") as f:
            f.write("VALUE = 1\n")

        script = PDVScript(
            uuid=scr_uuid,
            filename="run.py",
            module_id="my_mod",
            source_rel_path="scripts/run.py",
        )
        lib = PDVLib(
            uuid=lib_uuid,
            filename="helpers.py",
            module_id="my_mod",
            source_rel_path="lib/helpers.py",
        )
        module = PDVModule(module_id="my_mod", name="My Mod", version="0.1.0")

        descriptors = [
            serialize_node("my_mod", module, tmp_working_dir),
            serialize_node("my_mod.scripts", PDVTree(), tmp_working_dir),
            serialize_node("my_mod.scripts.run", script, tmp_working_dir),
            serialize_node("my_mod.lib", PDVTree(), tmp_working_dir),
            serialize_node("my_mod.lib.helpers", lib, tmp_working_dir),
        ]

        # Rehydrate into a fresh tree.
        fresh = PDVTree()
        fresh._working_dir = tmp_working_dir
        load_tree_index(fresh, descriptors, conflict_strategy="replace")

        loaded_script = fresh["my_mod.scripts.run"]
        loaded_lib = fresh["my_mod.lib.helpers"]
        assert isinstance(loaded_script, PDVScript)
        assert isinstance(loaded_lib, PDVLib)
        assert loaded_script.source_rel_path == "scripts/run.py"
        assert loaded_lib.source_rel_path == "lib/helpers.py"

    def test_all_descriptors_have_metadata(self, tmp_working_dir):
        """Every kind produces a descriptor with a metadata key."""
        from pdv.tree import PDVTree

        values = [
            ("folder", PDVTree()),
            ("scalar", 42),
            ("text", "hello"),
            ("mapping", {"a": 1}),
            ("sequence", [1, 2]),
        ]
        for name, value in values:
            desc = serialize_node(name, value, tmp_working_dir)
            assert "metadata" in desc, f"Missing metadata for kind={desc['type']}"
            assert "preview" in desc["metadata"], (
                f"Missing preview for kind={desc['type']}"
            )

    def test_ndarray_metadata(self, tmp_working_dir):
        numpy = pytest.importorskip("numpy")
        arr = numpy.array([[1.0, 2.0], [3.0, 4.0]])
        desc = serialize_node("data.arr", arr, tmp_working_dir)
        meta = desc["metadata"]
        assert meta["shape"] == [2, 2]
        assert meta["dtype"] == "float64"
        assert meta["size_bytes"] == arr.nbytes
        assert "preview" in meta

    def test_dataframe_metadata(self, tmp_working_dir):
        pandas = pytest.importorskip("pandas")
        pytest.importorskip("pyarrow")
        df = pandas.DataFrame({"a": [1, 2], "b": [3, 4]})
        desc = serialize_node("data.df", df, tmp_working_dir)
        meta = desc["metadata"]
        assert meta["shape"] == [2, 2]
        assert "preview" in meta


class TestCompositeMappingSerialize:
    """Unit tests for the composite-mapping branch of serialize_node."""

    def test_dict_with_ndarray_emits_composite_descriptor(
        self, tmp_working_dir
    ):
        numpy = pytest.importorskip("numpy")
        data = {"arr": numpy.array([1, 2]), "label": "x"}
        desc = serialize_node("m", data, tmp_working_dir)
        assert desc["type"] == KIND_MAPPING
        assert desc["has_children"] is True
        assert desc["storage"] == {"backend": "none", "format": "none"}
        assert desc["metadata"]["composite"] is True

    def test_json_native_dict_stays_inline(self, tmp_working_dir):
        desc = serialize_node("m", {"a": 1, "b": [1, 2]}, tmp_working_dir)
        assert desc["storage"]["backend"] == "inline"
        assert not desc["metadata"].get("composite")

    def test_sequence_with_ndarray_raises_helpful_error(self, tmp_working_dir):
        numpy = pytest.importorskip("numpy")
        with pytest.raises(PDVSerializationError, match="wrap"):
            serialize_node(
                "s", [numpy.array([1, 2]), numpy.array([3, 4])], tmp_working_dir
            )

    def test_pickle_fallback_node_writes_file(self, tmp_working_dir):
        from pdv.serialization import pickle_fallback_node
        from pdv.environment import uuid_tree_path

        obj = WeirdPicklable()
        desc = pickle_fallback_node("u", obj, tmp_working_dir)
        assert desc["storage"]["backend"] == "local_file"
        assert desc["storage"]["format"] == "pickle"
        assert desc["metadata"]["fallback"] == "pickle"
        assert "python_type" in desc["metadata"]
        node_uuid = desc["storage"]["uuid"]
        filename = desc["storage"]["filename"]
        assert os.path.exists(uuid_tree_path(tmp_working_dir, node_uuid, filename))
        # Round-trips via deserialize_node with trusted=True.
        restored = deserialize_node(
            desc["storage"], tmp_working_dir, trusted=True
        )
        assert isinstance(restored, WeirdPicklable)


class TestPDVFileSerialize:
    """Tests for bare PDVFile serialization and round-trip."""

    def test_bare_pdvfile_is_kind_file(self):
        from pdv.tree import PDVFile

        node = PDVFile(uuid="abc123def456", filename="mesh.h5")
        assert detect_kind(node) == KIND_FILE

    def test_pdvfile_serialize_emits_file_descriptor(self, tmp_working_dir):
        """serialize_node writes descriptor with format=file and local_file backend."""
        from pdv.tree import PDVFile

        node_uuid = "filenode_001"
        src_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(src_dir, exist_ok=True)
        src_path = os.path.join(src_dir, "mesh.h5")
        with open(src_path, "wb") as fh:
            fh.write(b"\x89HDF\r\n\x1a\nfake content")

        node = PDVFile(uuid=node_uuid, filename="mesh.h5")
        desc = serialize_node("simulation.mesh", node, tmp_working_dir)

        assert desc["type"] == KIND_FILE
        assert desc["uuid"] == node_uuid
        assert desc["storage"]["backend"] == "local_file"
        assert desc["storage"]["format"] == FORMAT_FILE
        assert desc["storage"]["uuid"] == node_uuid
        assert desc["storage"]["filename"] == "mesh.h5"
        assert "preview" in desc["metadata"]

    def test_pdvfile_serialize_copies_to_save_dir(
        self, tmp_working_dir, tmp_save_dir
    ):
        """Serialization copies the backing file from source_dir to working_dir (=save dir)."""
        from pdv.environment import uuid_tree_path
        from pdv.tree import PDVFile

        node_uuid = "filenode_002"
        src_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(src_dir, exist_ok=True)
        src_path = os.path.join(src_dir, "data.bin")
        payload = b"\x00\x01\x02hello\xff"
        with open(src_path, "wb") as fh:
            fh.write(payload)

        node = PDVFile(uuid=node_uuid, filename="data.bin")
        serialize_node(
            "imports.data",
            node,
            tmp_save_dir,
            source_dir=tmp_working_dir,
        )

        dest_path = uuid_tree_path(tmp_save_dir, node_uuid, "data.bin")
        assert os.path.exists(dest_path)
        with open(dest_path, "rb") as fh:
            assert fh.read() == payload

    def test_pdvfile_serialize_missing_file_raises(self, tmp_working_dir):
        from pdv.tree import PDVFile

        node = PDVFile(uuid="ghost_uuid_xx", filename="nowhere.dat")
        with pytest.raises(PDVSerializationError, match="File not found"):
            serialize_node("ghost", node, tmp_working_dir)

    def test_pdvfile_deserialize_returns_bytes(self, tmp_working_dir):
        """deserialize_node on FORMAT_FILE returns raw bytes (fallback path)."""
        from pdv.environment import ensure_parent, uuid_tree_path

        node_uuid = "deser_file_01"
        abs_path = uuid_tree_path(tmp_working_dir, node_uuid, "blob.bin")
        ensure_parent(abs_path)
        payload = b"raw-bytes-content"
        with open(abs_path, "wb") as fh:
            fh.write(payload)

        storage = {
            "backend": "local_file",
            "uuid": node_uuid,
            "filename": "blob.bin",
            "format": FORMAT_FILE,
        }
        result = deserialize_node(storage, tmp_working_dir, trusted=False)
        assert result == payload

    def test_pdvfile_round_trip_through_tree_loader(self, tmp_working_dir):
        """serialize_node + load_tree_index reconstruct a PDVFile with correct fields."""
        from pdv.tree import PDVFile, PDVTree
        from pdv.tree_loader import load_tree_index

        node_uuid = "rt_file_uuid1"
        src_dir = os.path.join(tmp_working_dir, "tree", node_uuid)
        os.makedirs(src_dir, exist_ok=True)
        src_path = os.path.join(src_dir, "dataset.h5")
        with open(src_path, "wb") as fh:
            fh.write(b"roundtrip-payload")

        node = PDVFile(uuid=node_uuid, filename="dataset.h5")
        descriptors = [serialize_node("imports.dataset", node, tmp_working_dir)]

        fresh = PDVTree()
        fresh._working_dir = tmp_working_dir
        load_tree_index(fresh, descriptors, conflict_strategy="replace")

        loaded = fresh["imports.dataset"]
        assert isinstance(loaded, PDVFile)
        assert loaded.uuid == node_uuid
        assert loaded.filename == "dataset.h5"
        assert loaded.resolve_path(tmp_working_dir) == src_path

    def test_pdvfile_preview(self):
        from pdv.tree import PDVFile

        node = PDVFile(uuid="prev_uuid_01", filename="camera.jpg")
        assert node_preview(node, KIND_FILE) == "camera.jpg"


class TestAddFile:
    """Tests for pdv.add_file() — user-facing file import API."""

    def _fresh_tree(self, tmp_working_dir):
        from pdv.tree import PDVTree

        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        return tree

    def test_add_file_imports_and_returns_pdvfile(self, tmp_working_dir, tmp_path):
        """add_file() copies the source and returns a PDVFile with fresh UUID."""
        import pdv.comms as comms_mod
        from pdv.environment import uuid_tree_path
        from pdv.namespace import PDVApp
        from pdv.tree import PDVFile

        source = tmp_path / "mesh.h5"
        source.write_bytes(b"\x89HDF\r\nmesh-data")

        tree = self._fresh_tree(tmp_working_dir)
        old_tree = comms_mod._pdv_tree
        comms_mod._pdv_tree = tree
        try:
            node = PDVApp().add_file(str(source))
        finally:
            comms_mod._pdv_tree = old_tree

        assert isinstance(node, PDVFile)
        assert node.filename == "mesh.h5"
        assert len(node.uuid) == 12
        dest = uuid_tree_path(tmp_working_dir, node.uuid, "mesh.h5")
        assert os.path.exists(dest)
        with open(dest, "rb") as fh:
            assert fh.read() == b"\x89HDF\r\nmesh-data"

    def test_add_file_expands_tilde(self, tmp_working_dir, tmp_path, monkeypatch):
        import pdv.comms as comms_mod
        from pdv.namespace import PDVApp

        monkeypatch.setenv("HOME", str(tmp_path))
        source = tmp_path / "mesh.h5"
        source.write_bytes(b"tilde-content")

        tree = self._fresh_tree(tmp_working_dir)
        old_tree = comms_mod._pdv_tree
        comms_mod._pdv_tree = tree
        try:
            node = PDVApp().add_file("~/mesh.h5")
        finally:
            comms_mod._pdv_tree = old_tree

        assert node.filename == "mesh.h5"

    def test_add_file_missing_source_raises(self, tmp_working_dir):
        import pdv.comms as comms_mod
        from pdv.namespace import PDVApp

        tree = self._fresh_tree(tmp_working_dir)
        old_tree = comms_mod._pdv_tree
        comms_mod._pdv_tree = tree
        try:
            with pytest.raises(FileNotFoundError):
                PDVApp().add_file("/definitely/not/a/real/path.xyz")
        finally:
            comms_mod._pdv_tree = old_tree

    def test_add_file_directory_raises(self, tmp_working_dir, tmp_path):
        import pdv.comms as comms_mod
        from pdv.namespace import PDVApp

        tree = self._fresh_tree(tmp_working_dir)
        old_tree = comms_mod._pdv_tree
        comms_mod._pdv_tree = tree
        try:
            with pytest.raises(ValueError, match="not a file"):
                PDVApp().add_file(str(tmp_path))
        finally:
            comms_mod._pdv_tree = old_tree

    def test_add_file_no_working_dir_raises(self, tmp_path):
        import pdv.comms as comms_mod
        from pdv.errors import PDVError
        from pdv.namespace import PDVApp
        from pdv.tree import PDVTree

        source = tmp_path / "mesh.h5"
        source.write_bytes(b"x")

        tree = PDVTree()  # no working_dir set
        old_tree = comms_mod._pdv_tree
        comms_mod._pdv_tree = tree
        try:
            with pytest.raises(PDVError, match="has not received pdv.init"):
                PDVApp().add_file(str(source))
        finally:
            comms_mod._pdv_tree = old_tree

    def test_add_file_then_assign_to_tree(self, tmp_working_dir, tmp_path):
        """End-to-end: imported PDVFile can be assigned to a tree path and resolved."""
        import pdv.comms as comms_mod
        from pdv.namespace import PDVApp
        from pdv.tree import PDVFile

        source = tmp_path / "table.csv"
        source.write_text("a,b\n1,2\n")

        tree = self._fresh_tree(tmp_working_dir)
        old_tree = comms_mod._pdv_tree
        comms_mod._pdv_tree = tree
        try:
            node = PDVApp().add_file(str(source))
            tree["imports.table"] = node
        finally:
            comms_mod._pdv_tree = old_tree

        assert isinstance(tree["imports.table"], PDVFile)
        resolved = tree["imports.table"].resolve_path(tmp_working_dir)
        assert os.path.exists(resolved)
        with open(resolved) as fh:
            assert fh.read() == "a,b\n1,2\n"
