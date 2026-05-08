"""
pdv-python/tests/test_serialization_nested.py — round-trip tests for
deeply nested heterogeneous container structures.

Each test:
1. Builds a value mixing list/tuple/set/frozenset/dict/scalar/complex/bytes
   at multiple nesting levels.
2. Computes its content digest via :func:`pdv.checksum.node_digest`.
3. Serializes through :func:`serialize_node` and deserializes through
   :func:`deserialize_node` (with ``trusted=True`` because container nodes
   that aren't JSON-faithful pickle, and the pickle read path requires it).
4. Computes the loaded value's digest.
5. Asserts the digests match — because :func:`_feed_node` type-tags
   list/tuple/set/frozenset and explicitly hashes complex via real+imag,
   a digest match implies type fidelity at every nesting level. A
   regression that silently coerces tuple → list (or set → frozenset)
   would change the digest and fail the test even if ``==`` still holds.
6. Sanity-checks the top-level type and ``==`` equality.

These tests exist because JSON, the cheapest inline format, collapses
tuple → list and can't represent set/frozenset/complex/bytes at all.
``serialize_node`` routes any container that wouldn't round-trip through
JSON to pickle, and these tests pin down that contract.
"""

from __future__ import annotations

import pytest

from pdv.checksum import node_digest
from pdv.serialization import deserialize_node, serialize_node


def _roundtrip(value, tmp_working_dir):
    """Serialize, deserialize, and assert the digest round-trips.

    Returns the loaded value so individual tests can do extra type checks.
    """
    digest_before = node_digest(value, tmp_working_dir)
    descriptor = serialize_node(
        "v", value, tmp_working_dir, trusted=True
    )
    loaded = deserialize_node(
        descriptor["storage"], tmp_working_dir, trusted=True
    )
    digest_after = node_digest(loaded, tmp_working_dir)
    assert digest_before == digest_after, (
        f"checksum mismatch: type fidelity was lost during round-trip\n"
        f"  before: {value!r}\n"
        f"  after:  {loaded!r}"
    )
    return loaded


class TestNestedTuples:
    """Tuple-only structures at varying depths."""

    def test_flat_tuple(self, tmp_working_dir):
        value = (1, 2, 3)
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, tuple)
        assert loaded == value

    def test_nested_tuple_two_deep(self, tmp_working_dir):
        value = (1, (2, 3), 4)
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, tuple)
        assert isinstance(loaded[1], tuple)

    def test_nested_tuple_five_deep(self, tmp_working_dir):
        value = (1, (2, (3, (4, (5, 6)))))
        loaded = _roundtrip(value, tmp_working_dir)
        cursor = loaded
        for _ in range(4):
            assert isinstance(cursor, tuple)
            cursor = cursor[-1]
        assert isinstance(cursor, tuple)

    def test_empty_tuple(self, tmp_working_dir):
        loaded = _roundtrip((), tmp_working_dir)
        assert isinstance(loaded, tuple)
        assert loaded == ()


class TestMixedSequences:
    """Sequences of mixed list/tuple/set/frozenset."""

    def test_list_of_tuples(self, tmp_working_dir):
        value = [(1, "a"), (2, "b"), (3, "c")]
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, list)
        assert all(isinstance(x, tuple) for x in loaded)

    def test_tuple_of_lists(self, tmp_working_dir):
        value = ([1, 2], [3, 4], [5, 6])
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, tuple)
        assert all(isinstance(x, list) for x in loaded)

    def test_list_of_sets_of_tuples(self, tmp_working_dir):
        value = [
            {(1, 2), (3, 4)},
            {(5, 6), (7, 8)},
            set(),
        ]
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, list)
        assert all(isinstance(s, set) for s in loaded)
        assert all(
            all(isinstance(t, tuple) for t in s) for s in loaded if s
        )

    def test_tuple_of_sets_of_tuples_of_lists(self, tmp_working_dir):
        # The four-level nesting the user explicitly mentioned. Inner lists
        # must be wrapped in a hashable (tuple) before going into a set, so
        # the actual layout is tuple → set → tuple → list.
        value = (
            {(1, ("a", "b")), (2, ("c", "d"))},
            {(3, ("e", "f"))},
        )
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, tuple)
        for s in loaded:
            assert isinstance(s, set)
            for t in s:
                assert isinstance(t, tuple)
                assert isinstance(t[1], tuple)

    def test_frozenset_of_tuples(self, tmp_working_dir):
        value = frozenset({(1, 2), (3, 4), (5, 6)})
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, frozenset)

    def test_list_of_frozensets(self, tmp_working_dir):
        value = [frozenset({1, 2}), frozenset({3, 4})]
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, list)
        assert all(isinstance(fs, frozenset) for fs in loaded)


class TestMixedScalarsInContainers:
    """Container structures with non-JSON scalar leaves."""

    def test_tuple_of_complex(self, tmp_working_dir):
        value = (1 + 2j, 3 - 4j, 5 + 0j)
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, tuple)
        assert all(isinstance(c, complex) for c in loaded)

    def test_list_of_bytes(self, tmp_working_dir):
        # A list of bytes isn't JSON-faithful (bytes aren't a JSON type),
        # so the whole list pickles.
        value = [b"\x00\x01", b"\xff\xfe", b""]
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, list)
        assert all(isinstance(b, bytes) for b in loaded)

    def test_dict_of_complex(self, tmp_working_dir):
        value = {"alpha": 1 + 2j, "beta": 3 - 4j}
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, dict)
        assert loaded["alpha"] == 1 + 2j


class TestMixedDicts:
    """Dicts containing tuples, sets, and other non-JSON-faithful values."""

    def test_dict_with_tuple_values(self, tmp_working_dir):
        # Tuples in dicts collapse to lists under JSON; pickle preserves them.
        value = {"point": (1.0, 2.0), "size": (10, 20, 30)}
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, dict)
        assert isinstance(loaded["point"], tuple)
        assert isinstance(loaded["size"], tuple)

    def test_dict_with_set_values(self, tmp_working_dir):
        value = {"primes": {2, 3, 5, 7}, "fibs": {1, 2, 3, 5, 8}}
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded["primes"], set)
        assert loaded["primes"] == {2, 3, 5, 7}

    def test_dict_with_nested_tuples(self, tmp_working_dir):
        value = {
            "outer": (1, (2, (3, 4))),
            "another": ((5, 6), (7, 8)),
        }
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded["outer"], tuple)
        assert isinstance(loaded["outer"][1], tuple)
        assert isinstance(loaded["another"][0], tuple)

    def test_dict_with_mixed_collection_values(self, tmp_working_dir):
        value = {
            "tuple_field": (1, 2, 3),
            "set_field": {4, 5, 6},
            "frozen_field": frozenset({7, 8}),
            "list_field": [9, 10],
            "scalar_field": 42,
            "complex_field": 1 + 2j,
            "bytes_field": b"\x00pdv\xff",
            "none_field": None,
        }
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded["tuple_field"], tuple)
        assert isinstance(loaded["set_field"], set)
        assert isinstance(loaded["frozen_field"], frozenset)
        assert isinstance(loaded["list_field"], list)
        assert isinstance(loaded["scalar_field"], int)
        assert isinstance(loaded["complex_field"], complex)
        assert isinstance(loaded["bytes_field"], bytes)
        assert loaded["none_field"] is None


class TestKitchenSink:
    """Maximum-mixed structures combining every supported flavor."""

    def test_lists_of_sets_of_tuples_of_lists(self, tmp_working_dir):
        # The exact phrasing from the user's request. Sets require hashable
        # members, so the inner "tuples of lists" is achieved by tuples
        # whose elements are tuples-of-tuples (lists aren't hashable).
        # The outer list contains sets containing tuples whose elements
        # are themselves lists — frozenset of tuple-with-list isn't allowed
        # because list isn't hashable, but a tuple's hash isn't computed
        # until inserted into a set, so this is only legal when the outer
        # is a list (not a set). We use list[ set[ tuple[ tuple ] ] ] here
        # because tuples-with-list-elements are unhashable.
        value = [
            {(1, (2, 3)), (4, (5, 6))},
            {(7, (8, 9))},
        ]
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded, list)
        for inner_set in loaded:
            assert isinstance(inner_set, set)
            for outer_tuple in inner_set:
                assert isinstance(outer_tuple, tuple)
                assert isinstance(outer_tuple[1], tuple)

    def test_dict_of_tuples_of_dicts(self, tmp_working_dir):
        value = {
            "a": ({"x": 1, "y": 2}, {"x": 3, "y": 4}),
            "b": ({"x": 5, "y": 6},),
        }
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded["a"], tuple)
        assert isinstance(loaded["a"][0], dict)

    def test_deeply_nested_kitchen_sink(self, tmp_working_dir):
        value = {
            "metadata": {"name": "experiment", "version": 3},
            "params": (1.5, 2.5, 3.5),
            "tags": {"physics", "plasma", "diagnostic"},
            "history": [
                {"step": 0, "value": 1 + 2j, "label": b"start"},
                {"step": 1, "value": 3 - 4j, "label": b"mid"},
                {"step": 2, "value": 5 + 0j, "label": b"end"},
            ],
            "lookup": {
                "by_id": frozenset({(1, "alpha"), (2, "beta")}),
                "by_name": (("alpha", 1), ("beta", 2)),
            },
            "empty_set": set(),
            "empty_tuple": (),
            "none_marker": None,
        }
        loaded = _roundtrip(value, tmp_working_dir)
        assert isinstance(loaded["params"], tuple)
        assert isinstance(loaded["tags"], set)
        assert isinstance(loaded["history"][0]["value"], complex)
        assert isinstance(loaded["history"][0]["label"], bytes)
        assert isinstance(loaded["lookup"]["by_id"], frozenset)
        assert isinstance(loaded["lookup"]["by_name"], tuple)
        assert isinstance(loaded["lookup"]["by_name"][0], tuple)
        assert loaded["empty_set"] == set()
        assert loaded["empty_tuple"] == ()


class TestXarrayPickleRoundtrip:
    """xarray DataArray and Dataset must round-trip via builtin pickle.

    First-class xarray serialization is planned for beta; until then PDV
    persists xarray values as pickle files (overriding any user-registered
    custom serializer) so projects always save and load without external
    registration.
    """

    def test_dataarray_roundtrip(self, tmp_working_dir):
        xr = pytest.importorskip("xarray")
        np = pytest.importorskip("numpy")
        da = xr.DataArray(
            np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]),
            dims=("time", "channel"),
            coords={"time": [0.0, 1.0], "channel": ["a", "b", "c"]},
            name="signal",
            attrs={"units": "V", "description": "demo"},
        )
        descriptor = serialize_node("v", da, tmp_working_dir, trusted=True)
        assert descriptor["storage"]["format"] == "pickle"
        loaded = deserialize_node(
            descriptor["storage"], tmp_working_dir, trusted=True
        )
        assert isinstance(loaded, xr.DataArray)
        assert loaded.name == "signal"
        assert loaded.dims == ("time", "channel")
        assert list(loaded.coords["channel"].values) == ["a", "b", "c"]
        assert loaded.attrs["units"] == "V"
        assert np.array_equal(loaded.values, da.values)

    def test_dataset_roundtrip(self, tmp_working_dir):
        xr = pytest.importorskip("xarray")
        np = pytest.importorskip("numpy")
        ds = xr.Dataset(
            data_vars={
                "voltage": (("t",), np.array([1.0, 2.0, 3.0])),
                "current": (("t",), np.array([0.1, 0.2, 0.3])),
            },
            coords={"t": [0.0, 0.5, 1.0]},
            attrs={"experiment": "demo"},
        )
        descriptor = serialize_node("v", ds, tmp_working_dir, trusted=True)
        assert descriptor["storage"]["format"] == "pickle"
        loaded = deserialize_node(
            descriptor["storage"], tmp_working_dir, trusted=True
        )
        assert isinstance(loaded, xr.Dataset)
        assert set(loaded.data_vars) == {"voltage", "current"}
        assert loaded.attrs["experiment"] == "demo"
        assert np.array_equal(loaded["voltage"].values, ds["voltage"].values)

    def test_dataarray_overrides_user_registered_serializer(
        self, tmp_working_dir
    ):
        """Even with a user-registered xarray serializer, builtin pickle wins."""
        xr = pytest.importorskip("xarray")
        np = pytest.importorskip("numpy")
        from pdv import serializers as _serializers

        save_calls = []

        def _save(obj, path):
            save_calls.append(path)
            with open(path, "w") as fh:
                fh.write("user-format")

        def _load(path):
            return "should-not-be-called"

        try:
            _serializers.register(
                xr.DataArray,
                format="user_xarray_dataarray",
                extension=".user",
                save=_save,
                load=_load,
            )
            da = xr.DataArray(np.array([1.0, 2.0]), dims=("x",))
            descriptor = serialize_node("v", da, tmp_working_dir, trusted=True)
            # Builtin pickle path must win; user serializer's save isn't called.
            assert descriptor["storage"]["format"] == "pickle"
            assert save_calls == []
            loaded = deserialize_node(
                descriptor["storage"], tmp_working_dir, trusted=True
            )
            assert isinstance(loaded, xr.DataArray)
            assert np.array_equal(loaded.values, da.values)
        finally:
            _serializers.clear()


class TestChecksumDistinguishesTypes:
    """Sanity checks that the checksum itself catches type-collapse."""

    def test_list_and_tuple_have_different_digests(self, tmp_working_dir):
        """If a regression flattens tuple → list, the digest must differ."""
        d_list = node_digest([1, 2, 3], tmp_working_dir)
        d_tuple = node_digest((1, 2, 3), tmp_working_dir)
        assert d_list != d_tuple

    def test_set_and_frozenset_have_different_digests(self, tmp_working_dir):
        d_set = node_digest({1, 2, 3}, tmp_working_dir)
        d_frozen = node_digest(frozenset({1, 2, 3}), tmp_working_dir)
        assert d_set != d_frozen

    def test_set_digest_is_order_independent(self, tmp_working_dir):
        """Sets are unordered, so iteration order shouldn't change the digest."""
        a = node_digest({3, 1, 2}, tmp_working_dir)
        b = node_digest({1, 2, 3}, tmp_working_dir)
        assert a == b

    def test_complex_real_imag_both_matter(self, tmp_working_dir):
        a = node_digest(1 + 2j, tmp_working_dir)
        b = node_digest(1 + 3j, tmp_working_dir)
        c = node_digest(2 + 2j, tmp_working_dir)
        assert a != b
        assert a != c
