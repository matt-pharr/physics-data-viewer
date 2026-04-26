"""
pdv-python/tests/test_serializers.py — Tests for the custom serializer registry.

Covers:
1. register() validation and MRO-walking lookup.
2. serialize_node() / deserialize_node() round-trip via a registered serializer
   for a class whose state cannot be pickled (simulating ctypes-backed objects).
3. Clear error when loading a node whose format has no registered handler.
"""

import json
import os

import pytest

from pdv import serializers
from pdv.errors import PDVSerializationError
from pdv.serialization import (
    KIND_UNKNOWN,
    deserialize_node,
    serialize_node,
)


class _Unpicklable:
    """Stand-in for a ctypes-wrapping object: pickle blows up on it."""

    def __init__(self, payload: dict):
        self.payload = payload

    def __reduce__(self):
        raise TypeError("simulated ctypes pointer — cannot be pickled")


class _UnpicklableChild(_Unpicklable):
    pass


@pytest.fixture(autouse=True)
def _clear_registry():
    serializers.clear()
    yield
    serializers.clear()


def _save_json(obj: _Unpicklable, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj.payload, fh)


def _load_json(path: str) -> _Unpicklable:
    with open(path, "r", encoding="utf-8") as fh:
        return _Unpicklable(json.load(fh))


def test_register_and_find():
    serializers.register(
        _Unpicklable,
        format="unpicklable_v1",
        extension=".json",
        save=_save_json,
        load=_load_json,
    )
    entry = serializers.find_for_value(_Unpicklable({"a": 1}))
    assert entry is not None
    assert entry.format == "unpicklable_v1"
    assert entry.extension == ".json"
    assert serializers.find_for_format("unpicklable_v1") is entry


def test_register_walks_mro():
    serializers.register(
        _Unpicklable,
        format="unpicklable_v1",
        extension=".json",
        save=_save_json,
        load=_load_json,
    )
    entry = serializers.find_for_value(_UnpicklableChild({"x": 2}))
    assert entry is not None
    assert entry.cls is _Unpicklable


def test_register_normalizes_extension_without_dot():
    serializers.register(
        _Unpicklable,
        format="unpicklable_v1",
        extension="json",
        save=_save_json,
        load=_load_json,
    )
    entry = serializers.find_for_format("unpicklable_v1")
    assert entry is not None
    assert entry.extension == ".json"


def test_register_rejects_builtin_format():
    with pytest.raises(PDVSerializationError, match="builtin format"):
        serializers.register(
            _Unpicklable,
            format="npy",
            extension=".bin",
            save=_save_json,
            load=_load_json,
        )


def test_register_rejects_empty_format():
    with pytest.raises(PDVSerializationError, match="non-empty"):
        serializers.register(
            _Unpicklable,
            format="",
            extension=".bin",
            save=_save_json,
            load=_load_json,
        )


def test_register_rejects_non_class():
    with pytest.raises(PDVSerializationError, match="must be a class"):
        serializers.register(
            "not a class",  # type: ignore[arg-type]
            format="x",
            extension=".bin",
            save=_save_json,
            load=_load_json,
        )


def test_serialize_roundtrip_with_custom_serializer(tmp_path):
    serializers.register(
        _Unpicklable,
        format="unpicklable_v1",
        extension=".json",
        save=_save_json,
        load=_load_json,
        preview=lambda obj: f"unpicklable({len(obj.payload)} keys)",
    )

    value = _Unpicklable({"alpha": 1, "beta": [2, 3]})
    descriptor = serialize_node("data.solver", value, str(tmp_path))

    assert descriptor["type"] == KIND_UNKNOWN
    assert descriptor["storage"]["backend"] == "local_file"
    assert descriptor["storage"]["format"] == "unpicklable_v1"
    assert descriptor["storage"]["filename"].endswith(".json")
    assert descriptor["metadata"]["python_type"].endswith("_Unpicklable")
    assert descriptor["metadata"]["serializer"].endswith("_Unpicklable")
    assert descriptor["metadata"]["preview"] == "unpicklable(2 keys)"

    from pdv.environment import uuid_tree_path
    abs_path = uuid_tree_path(str(tmp_path), descriptor["storage"]["uuid"], descriptor["storage"]["filename"])
    assert os.path.exists(abs_path)

    loaded = deserialize_node(descriptor["storage"], str(tmp_path))
    assert isinstance(loaded, _Unpicklable)
    assert loaded.payload == {"alpha": 1, "beta": [2, 3]}


def test_serialize_unknown_without_serializer_still_requires_trusted(tmp_path):
    with pytest.raises(
        PDVSerializationError, match="register a custom serializer|trusted=True"
    ):
        serialize_node("data.solver", _Unpicklable({}), str(tmp_path))


def test_deserialize_unknown_custom_format_raises(tmp_path):
    node_uuid = "unk_fmt_uuid"
    backing_dir = tmp_path / "tree" / node_uuid
    backing_dir.mkdir(parents=True, exist_ok=True)
    (backing_dir / "solver.json").write_text("{}")
    storage_ref = {
        "backend": "local_file",
        "uuid": node_uuid,
        "filename": "solver.json",
        "format": "no_such_format",
    }
    with pytest.raises(PDVSerializationError, match="no_such_format"):
        deserialize_node(storage_ref, str(tmp_path))


def test_public_register_serializer_entry_point_roundtrip(tmp_path):
    """End-to-end test using ``pdv.register_serializer`` (the public API
    that module developers actually call), modeled on the n-pendulum example.
    """
    import numpy as np

    import pdv

    class _Solution:
        def __init__(self, t, x, params):
            self.t = t
            self.x = x
            self.params = params

    def _save(sol, path):
        np.savez(path, t=sol.t, x=sol.x, params_json=np.array(json.dumps(sol.params)))

    def _load(path):
        data = np.load(path, allow_pickle=False)
        return _Solution(
            t=data["t"], x=data["x"], params=json.loads(str(data["params_json"]))
        )

    pdv.register_serializer(
        _Solution,
        format="solution_v1",
        extension=".npz",
        save=_save,
        load=_load,
    )

    sol = _Solution(t=np.linspace(0, 1, 5), x=np.arange(5.0), params={"k": 1})
    descriptor = serialize_node("results.run", sol, str(tmp_path))
    assert descriptor["storage"]["format"] == "solution_v1"
    assert descriptor["storage"]["filename"].endswith(".npz")

    loaded = deserialize_node(descriptor["storage"], str(tmp_path))
    assert isinstance(loaded, _Solution)
    np.testing.assert_array_equal(loaded.t, sol.t)
    np.testing.assert_array_equal(loaded.x, sol.x)
    assert loaded.params == {"k": 1}


def test_save_callback_error_is_wrapped(tmp_path):
    def _bad_save(obj, path):
        raise RuntimeError("solver checkpoint failed")

    serializers.register(
        _Unpicklable,
        format="unpicklable_v1",
        extension=".json",
        save=_bad_save,
        load=_load_json,
    )
    with pytest.raises(PDVSerializationError, match="solver checkpoint failed"):
        serialize_node("data.solver", _Unpicklable({}), str(tmp_path))
