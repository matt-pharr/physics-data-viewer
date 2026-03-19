"""
pdv-python/tests/test_serialization.py — Unit tests for pdv_kernel.serialization.

Tests cover:
1. detect_kind() for all supported types.
2. serialize_node() for each format: npy, parquet, json, txt, pickle.
3. deserialize_node() round-trips for each format.
4. node_preview() for representative values.
5. extract_docstring_preview() from Python files.
6. metadata sub-dict present and correct for all node kinds.

Reference: ARCHITECTURE.md §7.2, §7.3
"""

import json
import os
import pytest
from pdv_kernel.serialization import (
    detect_kind,
    serialize_node,
    deserialize_node,
    node_preview,
    extract_docstring_preview,
    KIND_NDARRAY,
    KIND_DATAFRAME,
    KIND_SERIES,
    KIND_SCALAR,
    KIND_TEXT,
    KIND_MAPPING,
    KIND_SEQUENCE,
    KIND_FOLDER,
    KIND_SCRIPT,
    KIND_MARKDOWN,
    KIND_MODULE,
    KIND_GUI,
    KIND_NAMELIST,
    KIND_LIB,
    KIND_UNKNOWN,
)
from pdv_kernel.errors import PDVSerializationError


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
        from pdv_kernel.serialization import KIND_BINARY
        assert detect_kind(b"data") == KIND_BINARY

    def test_numpy_array_is_ndarray(self):
        """numpy array returns KIND_NDARRAY (skipped if numpy absent)."""
        numpy = pytest.importorskip('numpy')
        assert detect_kind(numpy.array([1.0, 2.0])) == KIND_NDARRAY

    def test_pandas_dataframe_is_dataframe(self):
        """DataFrame returns KIND_DATAFRAME (skipped if pandas absent)."""
        pandas = pytest.importorskip('pandas')
        assert detect_kind(pandas.DataFrame({'a': [1, 2]})) == KIND_DATAFRAME

    def test_pandas_series_is_series(self):
        """Series returns KIND_SERIES (skipped if pandas absent)."""
        pandas = pytest.importorskip('pandas')
        assert detect_kind(pandas.Series([1, 2, 3])) == KIND_SERIES

    def test_unknown_object(self):
        """An arbitrary object returns KIND_UNKNOWN."""
        assert detect_kind(WeirdPicklable()) == KIND_UNKNOWN

    def test_pdv_tree_is_folder(self):
        """PDVTree returns KIND_FOLDER."""
        from pdv_kernel.tree import PDVTree
        assert detect_kind(PDVTree()) == KIND_FOLDER

    def test_pdv_script_is_script(self):
        """PDVScript returns KIND_SCRIPT."""
        from pdv_kernel.tree import PDVScript
        from pdv_kernel.serialization import KIND_SCRIPT
        assert detect_kind(PDVScript('scripts/test.py')) == KIND_SCRIPT


class TestSerializeAndDeserialize:
    """Round-trip tests for serialize_node() + deserialize_node()."""

    def test_scalar_json_roundtrip(self, tmp_working_dir):
        descriptor = serialize_node('x', 42, tmp_working_dir)
        assert descriptor['type'] == KIND_SCALAR
        assert descriptor['storage']['backend'] == 'inline'
        value = deserialize_node(descriptor['storage'], tmp_working_dir)
        assert value == 42

    def test_text_roundtrip(self, tmp_working_dir):
        descriptor = serialize_node('t', 'hello world', tmp_working_dir)
        assert descriptor['type'] == KIND_TEXT
        value = deserialize_node(descriptor['storage'], tmp_working_dir)
        assert value == 'hello world'

    def test_mapping_json_roundtrip(self, tmp_working_dir):
        data = {'key': 'val', 'num': 7}
        descriptor = serialize_node('m', data, tmp_working_dir)
        assert descriptor['type'] == KIND_MAPPING
        value = deserialize_node(descriptor['storage'], tmp_working_dir)
        assert value == data

    def test_sequence_roundtrip(self, tmp_working_dir):
        data = [1, 2, 3]
        descriptor = serialize_node('s', data, tmp_working_dir)
        assert descriptor['type'] == KIND_SEQUENCE
        value = deserialize_node(descriptor['storage'], tmp_working_dir)
        assert value == data

    def test_numpy_npy_roundtrip(self, tmp_working_dir):
        """numpy array → npy file → back to array (pytest.importorskip)."""
        numpy = pytest.importorskip('numpy')
        arr = numpy.array([[1.0, 2.0], [3.0, 4.0]])
        descriptor = serialize_node('data.arr', arr, tmp_working_dir)
        assert descriptor['type'] == KIND_NDARRAY
        assert descriptor['storage']['format'] == 'npy'
        assert descriptor['lazy'] is True
        value = deserialize_node(descriptor['storage'], tmp_working_dir)
        assert numpy.array_equal(value, arr)

    def test_pandas_dataframe_parquet_roundtrip(self, tmp_working_dir):
        """DataFrame → parquet → back to DataFrame (pytest.importorskip)."""
        pandas = pytest.importorskip('pandas')
        pytest.importorskip('pyarrow')
        df = pandas.DataFrame({'a': [1, 2, 3], 'b': [4.0, 5.0, 6.0]})
        descriptor = serialize_node('data.df', df, tmp_working_dir)
        assert descriptor['type'] == KIND_DATAFRAME
        assert descriptor['storage']['format'] == 'parquet'
        value = deserialize_node(descriptor['storage'], tmp_working_dir)
        assert list(value['a']) == [1, 2, 3]

    def test_unknown_raises_without_trusted(self, tmp_working_dir):
        """serialize_node() raises PDVSerializationError for unknown type without trusted=True."""
        with pytest.raises(PDVSerializationError):
            serialize_node('u', WeirdPicklable(), tmp_working_dir)

    def test_unknown_pickle_roundtrip_trusted(self, tmp_working_dir):
        """serialize_node() with trusted=True pickles unknown types."""
        obj = WeirdPicklable()
        descriptor = serialize_node('u', obj, tmp_working_dir, trusted=True)
        assert descriptor['storage']['format'] == 'pickle'
        restored = deserialize_node(descriptor['storage'], tmp_working_dir, trusted=True)
        assert isinstance(restored, WeirdPicklable)

    def test_pickle_raises_without_trusted(self, tmp_working_dir):
        """deserialize_node raises for pickle format without trusted=True."""
        descriptor = serialize_node('u', WeirdPicklable(), tmp_working_dir, trusted=True)
        with pytest.raises(PDVSerializationError):
            deserialize_node(descriptor['storage'], tmp_working_dir, trusted=False)

    def test_descriptor_fields_present(self, tmp_working_dir):
        """Returned descriptor contains all required fields including metadata."""
        descriptor = serialize_node('my.node', 123, tmp_working_dir)
        required = {'id', 'path', 'key', 'parent_path', 'type', 'has_children',
                    'lazy', 'created_at', 'updated_at', 'storage', 'metadata'}
        assert required.issubset(descriptor.keys())
        assert descriptor['id'] == 'my.node'
        assert descriptor['key'] == 'node'
        assert descriptor['parent_path'] == 'my'
        assert 'preview' in descriptor['metadata']


class TestNodePreview:
    """Tests for node_preview()."""

    def test_scalar_preview(self):
        assert node_preview(42, KIND_SCALAR) == '42'

    def test_text_preview_truncates(self):
        long_text = 'x' * 100
        preview = node_preview(long_text, KIND_TEXT)
        assert len(preview) <= 100
        assert '...' in preview

    def test_text_short_no_truncation(self):
        short = 'hello'
        assert node_preview(short, KIND_TEXT) == 'hello'

    def test_ndarray_preview(self):
        numpy = pytest.importorskip('numpy')
        arr = numpy.array([[1.0, 2.0], [3.0, 4.0]])
        preview = node_preview(arr, KIND_NDARRAY)
        assert 'array' in preview.lower() or 'float' in preview.lower()

    def test_mapping_preview(self):
        preview = node_preview({'a': 1, 'b': 2}, KIND_MAPPING)
        assert 'dict' in preview.lower()

    def test_sequence_preview(self):
        preview = node_preview([1, 2, 3], KIND_SEQUENCE)
        assert 'list' in preview.lower()


class TestExtractDocstringPreview:
    """Tests for extract_docstring_preview()."""

    def test_extracts_first_line(self, tmp_path):
        script = tmp_path / 'myscript.py'
        script.write_text('"""My script docstring.\n\nMore details here.\n"""\n\nx = 1\n')
        result = extract_docstring_preview(str(script))
        assert result == 'My script docstring.'

    def test_no_docstring_returns_none(self, tmp_path):
        script = tmp_path / 'nodoc.py'
        script.write_text('x = 1\n')
        result = extract_docstring_preview(str(script))
        assert result is None

    def test_missing_file_returns_none(self, tmp_path):
        result = extract_docstring_preview(str(tmp_path / 'nonexistent.py'))
        assert result is None


class TestMetadataSubDict:
    """Tests that all descriptors contain a metadata sub-dict with type-specific fields."""

    def test_module_descriptor_metadata(self, tmp_working_dir):
        from pdv_kernel.tree import PDVModule
        mod = PDVModule(module_id="test_mod", name="Test Module", version="1.0.0")
        desc = serialize_node('mymod', mod, tmp_working_dir)
        assert 'metadata' in desc
        meta = desc['metadata']
        assert meta['module_id'] == 'test_mod'
        assert meta['name'] == 'Test Module'
        assert meta['version'] == '1.0.0'
        assert 'preview' in meta

    def test_gui_descriptor_metadata(self, tmp_working_dir):
        from pdv_kernel.tree import PDVGui
        gui_file = os.path.join(tmp_working_dir, 'tree', 'mod', 'gui.gui.json')
        os.makedirs(os.path.dirname(gui_file), exist_ok=True)
        with open(gui_file, 'w') as f:
            f.write('{}')
        gui = PDVGui(relative_path=gui_file, module_id="test_mod")
        desc = serialize_node('mod.gui', gui, tmp_working_dir)
        assert 'metadata' in desc
        meta = desc['metadata']
        assert meta['module_id'] == 'test_mod'
        assert 'preview' in meta

    def test_namelist_descriptor_metadata(self, tmp_working_dir):
        from pdv_kernel.tree import PDVNamelist
        nml_file = os.path.join(tmp_working_dir, 'tree', 'mod', 'solver.nml')
        os.makedirs(os.path.dirname(nml_file), exist_ok=True)
        with open(nml_file, 'w') as f:
            f.write('&solver /\n')
        nml = PDVNamelist(relative_path=nml_file, format='fortran', module_id='test_mod')
        desc = serialize_node('mod.solver', nml, tmp_working_dir)
        assert 'metadata' in desc
        meta = desc['metadata']
        assert meta['module_id'] == 'test_mod'
        assert meta['namelist_format'] == 'fortran'
        assert 'preview' in meta

    def test_lib_descriptor_metadata(self, tmp_working_dir):
        from pdv_kernel.tree import PDVLib
        lib_file = os.path.join(tmp_working_dir, 'tree', 'mod', 'lib', 'helpers.py')
        os.makedirs(os.path.dirname(lib_file), exist_ok=True)
        with open(lib_file, 'w') as f:
            f.write('# helpers\n')
        lib = PDVLib(relative_path=lib_file, module_id='test_mod')
        desc = serialize_node('mod.lib.helpers', lib, tmp_working_dir)
        assert 'metadata' in desc
        meta = desc['metadata']
        assert meta['module_id'] == 'test_mod'
        assert meta['language'] == 'python'
        assert 'preview' in meta

    def test_script_descriptor_metadata(self, tmp_working_dir):
        from pdv_kernel.tree import PDVScript
        script_file = os.path.join(tmp_working_dir, 'tree', 'run.py')
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, 'w') as f:
            f.write('"""My script."""\ndef run(pdv_tree: dict):\n    return {}\n')
        script = PDVScript(relative_path=script_file, language='python', doc='My script.')
        desc = serialize_node('run', script, tmp_working_dir)
        assert 'metadata' in desc
        meta = desc['metadata']
        assert meta['language'] == 'python'
        assert meta['doc'] == 'My script.'
        assert 'preview' in meta

    def test_all_descriptors_have_metadata(self, tmp_working_dir):
        """Every kind produces a descriptor with a metadata key."""
        from pdv_kernel.tree import PDVTree, PDVScript, PDVModule, PDVNote
        values = [
            ('folder', PDVTree()),
            ('scalar', 42),
            ('text', 'hello'),
            ('mapping', {'a': 1}),
            ('sequence', [1, 2]),
        ]
        for name, value in values:
            desc = serialize_node(name, value, tmp_working_dir)
            assert 'metadata' in desc, f"Missing metadata for kind={desc['type']}"
            assert 'preview' in desc['metadata'], f"Missing preview for kind={desc['type']}"

    def test_ndarray_metadata(self, tmp_working_dir):
        numpy = pytest.importorskip('numpy')
        arr = numpy.array([[1.0, 2.0], [3.0, 4.0]])
        desc = serialize_node('data.arr', arr, tmp_working_dir)
        meta = desc['metadata']
        assert meta['shape'] == [2, 2]
        assert meta['dtype'] == 'float64'
        assert meta['size_bytes'] == arr.nbytes
        assert 'preview' in meta

    def test_dataframe_metadata(self, tmp_working_dir):
        pandas = pytest.importorskip('pandas')
        pytest.importorskip('pyarrow')
        df = pandas.DataFrame({'a': [1, 2], 'b': [3, 4]})
        desc = serialize_node('data.df', df, tmp_working_dir)
        meta = desc['metadata']
        assert meta['shape'] == [2, 2]
        assert 'preview' in meta
