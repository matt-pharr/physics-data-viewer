"""
pdv-python/tests/test_dunder_protocol.py — Tests for the dunder protocol.

Covers the six methods a custom class may define to opt into PDV without
importing the ``pdv`` package: ``__pdv_format__``, ``__pdv_serialize__``,
``__pdv_deserialize__`` (required as a set) plus ``__pdv_preview__``,
``__pdv_handle__``, ``__pdv_digest__``.

Reference: ARCHITECTURE.md §7.2 (dunder-protocol hook).
"""

from __future__ import annotations

import json
import os
import sys
import textwrap

import pytest

from pdv import serializers
from pdv.checksum import node_digest
from pdv.errors import PDVSerializationError
from pdv.modules import (
    clear_handlers,
    dispatch_handler,
    handle,
    has_handler_for,
)
from pdv.serialization import (
    KIND_UNKNOWN,
    deserialize_node,
    node_preview,
    serialize_node,
)


@pytest.fixture(autouse=True)
def _clean_registries():
    serializers.clear()
    clear_handlers()
    yield
    serializers.clear()
    clear_handlers()


# ---------------------------------------------------------------------------
# Reference dunder classes used by multiple tests.
# ---------------------------------------------------------------------------


class _FullDunder:
    """A class with the full trio and all optional methods."""

    def __init__(self, payload: dict):
        self.payload = payload

    @classmethod
    def __pdv_format__(cls) -> tuple[str, str]:
        return ("full_dunder_v1", ".json")

    def __pdv_serialize__(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.payload, fh)

    @classmethod
    def __pdv_deserialize__(cls, path: str) -> "_FullDunder":
        with open(path, "r", encoding="utf-8") as fh:
            return cls(json.load(fh))

    def __pdv_preview__(self) -> str:
        return f"full({len(self.payload)} keys)"

    def __pdv_handle__(self, path: str, pdv_tree) -> None:
        # Side effect recorded by tests via a sentinel list.
        _FullDunder.last_handle_call = (path, pdv_tree, self.payload)

    def __pdv_digest__(self) -> bytes:
        return json.dumps(self.payload, sort_keys=True).encode("utf-8")


class _TrioOnly:
    """A class with only the required trio — no optional methods."""

    def __init__(self, value: int):
        self.value = value

    @classmethod
    def __pdv_format__(cls) -> tuple[str, str]:
        return ("trio_only_v1", ".txt")

    def __pdv_serialize__(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(str(self.value))

    @classmethod
    def __pdv_deserialize__(cls, path: str) -> "_TrioOnly":
        with open(path, "r", encoding="utf-8") as fh:
            return cls(int(fh.read()))


# ---------------------------------------------------------------------------
# 1. Full-protocol round-trip.
# ---------------------------------------------------------------------------


def test_full_protocol_round_trip(tmp_path):
    value = _FullDunder({"a": 1, "b": [2, 3]})
    descriptor = serialize_node("data.thing", value, str(tmp_path))

    assert descriptor["type"] == KIND_UNKNOWN
    assert descriptor["storage"]["backend"] == "local_file"
    assert descriptor["storage"]["format"] == "full_dunder_v1"
    assert descriptor["storage"]["filename"].endswith(".json")
    assert descriptor["metadata"]["serializer"].startswith("dunder:")
    assert descriptor["metadata"]["serializer"].endswith("_FullDunder")
    assert descriptor["metadata"]["python_type"].endswith("_FullDunder")
    assert descriptor["metadata"]["preview"] == "full(2 keys)"

    loaded = deserialize_node(
        descriptor["storage"],
        str(tmp_path),
        python_type=descriptor["metadata"]["python_type"],
    )
    assert isinstance(loaded, _FullDunder)
    assert loaded.payload == {"a": 1, "b": [2, 3]}


# ---------------------------------------------------------------------------
# 2. Trio-only class works without optional methods.
# ---------------------------------------------------------------------------


def test_trio_only_works(tmp_path):
    value = _TrioOnly(42)
    descriptor = serialize_node("data.n", value, str(tmp_path))

    assert descriptor["storage"]["format"] == "trio_only_v1"
    assert descriptor["metadata"]["serializer"].endswith("_TrioOnly")
    # No __pdv_handle__ → no handler.
    assert has_handler_for(value) is False

    loaded = deserialize_node(
        descriptor["storage"],
        str(tmp_path),
        python_type=descriptor["metadata"]["python_type"],
    )
    assert isinstance(loaded, _TrioOnly)
    assert loaded.value == 42


# ---------------------------------------------------------------------------
# 3. Partial trio is silently ignored (falls through to pickle).
# ---------------------------------------------------------------------------


# Six module-level partial-trio classes so the negative-fallback can be
# verified end-to-end (the pickle fallback needs module-discoverable classes).


class _PartialFmt:
    @classmethod
    def __pdv_format__(cls):
        return ("ignored", ".bin")


class _PartialSer:
    def __pdv_serialize__(self, path):
        open(path, "wb").write(b"")


class _PartialDes:
    @classmethod
    def __pdv_deserialize__(cls, path):
        return cls()


class _PartialFmtSer:
    @classmethod
    def __pdv_format__(cls):
        return ("ignored", ".bin")

    def __pdv_serialize__(self, path):
        open(path, "wb").write(b"")


class _PartialFmtDes:
    @classmethod
    def __pdv_format__(cls):
        return ("ignored", ".bin")

    @classmethod
    def __pdv_deserialize__(cls, path):
        return cls()


class _PartialSerDes:
    def __pdv_serialize__(self, path):
        open(path, "wb").write(b"")

    @classmethod
    def __pdv_deserialize__(cls, path):
        return cls()


@pytest.mark.parametrize(
    "cls",
    [
        _PartialFmt,
        _PartialSer,
        _PartialDes,
        _PartialFmtSer,
        _PartialFmtDes,
        _PartialSerDes,
    ],
)
def test_partial_trio_silently_ignored(cls, tmp_path):
    obj = cls()
    entry = serializers.find_for_value_dunder(obj)
    assert entry is None, (
        f"Partial trio for {cls.__name__} should not synthesize a "
        f"DunderEntry but got {entry}"
    )

    # End-to-end: serialize_node falls through to the pickle fallback (with
    # trusted=True), so no dunder metadata appears on the descriptor.
    descriptor = serialize_node(
        "data.partial", obj, str(tmp_path), trusted=True
    )
    assert descriptor["storage"]["format"] == "pickle"
    assert "serializer" not in descriptor.get("metadata", {})


def test_handle_only_class_is_fine():
    """A class with only ``__pdv_handle__`` (no trio) has no DunderEntry but
    still routes through ``dispatch_handler``."""

    calls: list = []

    class _HandleOnly:
        def __pdv_handle__(self, path, pdv_tree):
            calls.append((path, pdv_tree))

    obj = _HandleOnly()
    assert serializers.find_for_value_dunder(obj) is None
    assert has_handler_for(obj) is True
    result = dispatch_handler(obj, "a.b", {"fake": "tree"})
    assert result == {"dispatched": True}
    assert calls == [("a.b", {"fake": "tree"})]


# ---------------------------------------------------------------------------
# 4. __pdv_format__ returning a reserved name raises.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "reserved",
    ["npy", "json", "txt", "pickle", "markdown", "inline", "module_meta"],
)
def test_reserved_format_name_raises(reserved):
    class _Bad:
        @classmethod
        def __pdv_format__(cls):
            return (reserved, ".x")

        def __pdv_serialize__(self, path):
            open(path, "wb").write(b"")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls()

    with pytest.raises(PDVSerializationError, match="builtin format"):
        serializers.find_for_value_dunder(_Bad())


# ---------------------------------------------------------------------------
# 5. Format collision with a register_serializer entry for a different class.
# ---------------------------------------------------------------------------


def test_format_collides_with_registered_different_class(tmp_path):
    class _Other:
        def __init__(self, x):
            self.x = x

    def _save(o, p):
        with open(p, "w") as fh:
            fh.write(str(o.x))

    def _load(p):
        with open(p) as fh:
            return _Other(int(fh.read()))

    serializers.register(
        _Other, format="shared_fmt", extension=".txt", save=_save, load=_load
    )

    class _Mine:
        @classmethod
        def __pdv_format__(cls):
            return ("shared_fmt", ".txt")

        def __pdv_serialize__(self, path):
            open(path, "w").write("")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls()

    with pytest.raises(PDVSerializationError, match="already registered"):
        serializers.find_for_value_dunder(_Mine())


# ---------------------------------------------------------------------------
# 6. Same class: registered wins, dunder branch never reached.
# ---------------------------------------------------------------------------


def test_registered_wins_for_same_class(tmp_path):
    class _Both:
        def __init__(self, x):
            self.x = x

        @classmethod
        def __pdv_format__(cls):
            return ("both_fmt", ".dat")

        def __pdv_serialize__(self, path):
            with open(path, "w") as fh:
                fh.write("DUNDER:" + str(self.x))

        @classmethod
        def __pdv_deserialize__(cls, path):
            with open(path) as fh:
                return cls(fh.read())

    def _registered_save(o, p):
        with open(p, "w") as fh:
            fh.write("REGISTERED:" + str(o.x))

    def _registered_load(p):
        with open(p) as fh:
            return _Both(fh.read())

    # Register first with the SAME format name as the dunder reports.
    serializers.register(
        _Both,
        format="both_fmt",
        extension=".dat",
        save=_registered_save,
        load=_registered_load,
    )

    value = _Both("hello")
    descriptor = serialize_node("data.both", value, str(tmp_path))

    # Registered serializer wins: no "dunder:" prefix on metadata.serializer.
    assert not descriptor["metadata"]["serializer"].startswith("dunder:")
    # File contains the REGISTERED save's output, not the dunder's.
    from pdv.environment import uuid_tree_path

    abs_path = uuid_tree_path(
        str(tmp_path),
        descriptor["storage"]["uuid"],
        descriptor["storage"]["filename"],
    )
    with open(abs_path) as fh:
        assert fh.read().startswith("REGISTERED:")


# ---------------------------------------------------------------------------
# 7. register_serializer takes priority over dunder (different class case
# is covered above; here a class with both, no format collision).
# ---------------------------------------------------------------------------


def test_register_serializer_takes_priority_over_dunder(tmp_path):
    class _Both:
        def __init__(self, x):
            self.x = x

        @classmethod
        def __pdv_format__(cls):
            return ("dunder_only_fmt", ".d")

        def __pdv_serialize__(self, path):
            open(path, "w").write("dunder")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls("dunder")

    serializers.register(
        _Both,
        format="registered_fmt",
        extension=".r",
        save=lambda o, p: open(p, "w").write("registered"),
        load=lambda p: _Both("registered"),
    )

    descriptor = serialize_node("x", _Both("v"), str(tmp_path))
    assert descriptor["storage"]["format"] == "registered_fmt"
    assert not descriptor["metadata"]["serializer"].startswith("dunder:")


# ---------------------------------------------------------------------------
# 8. @pdv.handle takes priority over __pdv_handle__.
# ---------------------------------------------------------------------------


def test_registered_handler_takes_priority_over_dunder_handle():
    calls: list = []

    class _Both:
        def __pdv_handle__(self, path, pdv_tree):
            calls.append("dunder")

    @handle(_Both)
    def on_both(obj, path, tree):
        calls.append("registered")

    result = dispatch_handler(_Both(), "x", None)
    assert result == {"dispatched": True}
    assert calls == ["registered"]


# ---------------------------------------------------------------------------
# 9. __pdv_preview__ invoked when no registered serializer preview exists.
# ---------------------------------------------------------------------------


def test_dunder_preview_used_when_no_registered_preview():
    value = _FullDunder({"a": 1, "b": 2, "c": 3})
    preview = node_preview(value, KIND_UNKNOWN)
    assert preview == "full(3 keys)"


def test_dunder_preview_truncated_to_100():
    class _Verbose:
        @classmethod
        def __pdv_format__(cls):
            return ("verbose_v1", ".bin")

        def __pdv_serialize__(self, path):
            open(path, "wb").write(b"")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls()

        def __pdv_preview__(self):
            return "x" * 500

    preview = node_preview(_Verbose(), KIND_UNKNOWN)
    assert len(preview) == 100


# ---------------------------------------------------------------------------
# 10. __pdv_digest__ affects autosave cache.
# ---------------------------------------------------------------------------


def test_pdv_digest_makes_equal_values_cache_hit():
    a = _FullDunder({"x": 1, "y": 2})
    b = _FullDunder({"y": 2, "x": 1})  # same content, different insert order
    assert node_digest(a, None) == node_digest(b, None)


def test_pdv_digest_distinguishes_different_values():
    a = _FullDunder({"x": 1})
    b = _FullDunder({"x": 2})
    assert node_digest(a, None) != node_digest(b, None)


def test_autosave_cache_hits_when_digest_unchanged(tmp_path):
    value = _FullDunder({"a": 1})
    cache: dict = {}
    hits = [0]
    descriptor1 = serialize_node(
        "data.thing",
        value,
        str(tmp_path),
        autosave_cache=cache,
        autosave_hits=hits,
    )
    assert hits[0] == 0  # first save populates cache, no hit

    # Same instance → same digest → cache hit, descriptor reused.
    descriptor2 = serialize_node(
        "data.thing",
        value,
        str(tmp_path),
        autosave_cache=cache,
        autosave_hits=hits,
    )
    assert hits[0] == 1
    assert descriptor2 is descriptor1  # reused cached descriptor


# ---------------------------------------------------------------------------
# 11. dispatch_handler invokes __pdv_handle__ with (path, pdv_tree).
# ---------------------------------------------------------------------------


def test_dispatch_handler_invokes_pdv_handle():
    calls: list = []

    class _Handled:
        def __pdv_handle__(self, path, pdv_tree):
            calls.append((path, pdv_tree))

    result = dispatch_handler(_Handled(), "tree.path", {"the": "tree"})
    assert result == {"dispatched": True}
    assert calls == [("tree.path", {"the": "tree"})]


def test_dispatch_handler_pdv_handle_exception_returned_as_error():
    class _Boom:
        def __pdv_handle__(self, path, pdv_tree):
            raise RuntimeError("kaboom")

    result = dispatch_handler(_Boom(), "x", None)
    assert result["dispatched"] is False
    assert "__pdv_handle__ failed" in result["error"]
    assert "kaboom" in result["error"]


def test_dispatch_handler_registered_exception_returned_as_error():
    class _Boom:
        pass

    @handle(_Boom)
    def on_boom(obj, path, tree):
        raise RuntimeError("registered kaboom")

    result = dispatch_handler(_Boom(), "x", None)
    assert result["dispatched"] is False
    assert "failed" in result["error"]
    assert "registered kaboom" in result["error"]


# ---------------------------------------------------------------------------
# 12. has_handler_for returns True for dunder-only classes.
# ---------------------------------------------------------------------------


def test_has_handler_for_dunder_only():
    class _Dunder:
        def __pdv_handle__(self, path, pdv_tree):
            pass

    assert has_handler_for(_Dunder()) is True


# ---------------------------------------------------------------------------
# 13. End-to-end save + load with class NOT imported by PDV before load.
# ---------------------------------------------------------------------------


def test_end_to_end_save_load_class_not_pre_imported(tmp_path, monkeypatch):
    """Mimic a PyPI package whose dunder class PDV has never touched."""
    pkg_dir = tmp_path / "synthpkg_src"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "geq.py").write_text(textwrap.dedent("""
        class FakeGeq:
            def __init__(self, b0: float):
                self.b0 = b0

            @classmethod
            def __pdv_format__(cls):
                return ("fakegeq_v1", ".geqdsk")

            def __pdv_serialize__(self, path):
                with open(path, "w") as fh:
                    fh.write(f"b0={self.b0}\\n")

            @classmethod
            def __pdv_deserialize__(cls, path):
                with open(path) as fh:
                    line = fh.read().strip()
                return cls(float(line.split("=", 1)[1]))
    """))

    monkeypatch.syspath_prepend(str(tmp_path))

    save_dir = tmp_path / "save"
    save_dir.mkdir()

    # Import once to populate, save, then drop module from sys.modules.
    import importlib
    pkg = importlib.import_module("synthpkg_src")
    geq = importlib.import_module("synthpkg_src.geq")
    value = geq.FakeGeq(2.1)
    descriptor = serialize_node("g", value, str(save_dir))
    assert descriptor["storage"]["format"] == "fakegeq_v1"
    assert descriptor["metadata"]["python_type"].endswith("FakeGeq")
    assert descriptor["metadata"]["serializer"].startswith("dunder:")

    # Drop from sys.modules and clear caches so the load reimports.
    for k in list(sys.modules):
        if k.startswith("synthpkg_src"):
            del sys.modules[k]
    serializers.clear()
    del pkg, geq, value

    loaded = deserialize_node(
        descriptor["storage"],
        str(save_dir),
        trusted=True,
        python_type=descriptor["metadata"]["python_type"],
    )
    assert loaded.b0 == 2.1
    # Confirm the class was actually reimported through importlib (not the
    # held-over reference): its module string matches the synthpkg path.
    assert type(loaded).__module__ == "synthpkg_src.geq"


# ---------------------------------------------------------------------------
# 14. Bogus python_type surfaces the new error message text.
# ---------------------------------------------------------------------------


def test_bogus_python_type_error_message(tmp_path):
    node_uuid = "bogus_uuid"
    backing = tmp_path / "tree" / node_uuid
    backing.mkdir(parents=True, exist_ok=True)
    (backing / "x.geqdsk").write_text("")
    storage_ref = {
        "backend": "local_file",
        "uuid": node_uuid,
        "filename": "x.geqdsk",
        "format": "fakegeq_v1",
    }
    with pytest.raises(PDVSerializationError) as ei:
        deserialize_node(
            storage_ref,
            str(tmp_path),
            trusted=True,
            python_type="nonexistent.module.Thing",
        )
    msg = str(ei.value)
    assert "fakegeq_v1" in msg
    assert "nonexistent.module.Thing" in msg
    assert "install" in msg.lower()


def test_serialize_raises_wraps_with_class_name(tmp_path):
    """A failing ``__pdv_serialize__`` surfaces as ``PDVSerializationError``
    naming the dunder class and the tree path."""

    class _BadSerialize:
        @classmethod
        def __pdv_format__(cls):
            return ("bad_serialize_v1", ".bin")

        def __pdv_serialize__(self, path):
            raise RuntimeError("disk full")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls()

    with pytest.raises(PDVSerializationError) as ei:
        serialize_node("data.x", _BadSerialize(), str(tmp_path))
    msg = str(ei.value)
    assert "Dunder serializer" in msg
    assert "_BadSerialize" in msg
    assert "data.x" in msg
    assert "disk full" in msg
    # Original exception is chained for debugging.
    assert isinstance(ei.value.__cause__, RuntimeError)


def test_deserialize_raises_wraps_with_python_type(tmp_path):
    """A failing ``__pdv_deserialize__`` surfaces as ``PDVSerializationError``
    naming the python_type and the underlying error."""
    pkg_dir = tmp_path / "deserr_pkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "mod.py").write_text(textwrap.dedent("""
        class BadLoad:
            @classmethod
            def __pdv_format__(cls):
                return ("bad_load_v1", ".bin")

            def __pdv_serialize__(self, path):
                open(path, "wb").write(b"")

            @classmethod
            def __pdv_deserialize__(cls, path):
                raise ValueError("corrupt blob")
    """))

    import importlib

    sys.path.insert(0, str(tmp_path))
    try:
        mod = importlib.import_module("deserr_pkg.mod")
        save_dir = tmp_path / "save"
        save_dir.mkdir()
        descriptor = serialize_node("v", mod.BadLoad(), str(save_dir))

        with pytest.raises(PDVSerializationError) as ei:
            deserialize_node(
                descriptor["storage"],
                str(save_dir),
                trusted=True,
                python_type=descriptor["metadata"]["python_type"],
            )
        msg = str(ei.value)
        assert "Dunder deserializer" in msg
        assert "BadLoad" in msg
        assert "__pdv_deserialize__" in msg
        assert "corrupt blob" in msg
        assert isinstance(ei.value.__cause__, ValueError)
    finally:
        sys.path.remove(str(tmp_path))
        for k in list(sys.modules):
            if k.startswith("deserr_pkg"):
                del sys.modules[k]


def test_class_lost_pdv_deserialize_surfaces_distinct_message(tmp_path):
    """A class that imports cleanly but no longer defines
    ``__pdv_deserialize__`` (e.g. the user upgraded the defining package and
    the dunder method was removed) gets the LOOKUP_CLASS_UNLOADABLE branch
    of the error message — distinct from the "install the package" branch
    that fires for a missing module. The package is installed; telling the
    user to install it again would be misleading."""
    pkg_dir = tmp_path / "lostmethod_pkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    # The class exists and imports cleanly — but defines NO dunder methods.
    (pkg_dir / "mod.py").write_text("class Thing:\n    pass\n")

    sys.path.insert(0, str(tmp_path))
    try:
        node_uuid = "lostmethod_uuid"
        backing = tmp_path / "tree" / node_uuid
        backing.mkdir(parents=True, exist_ok=True)
        (backing / "x.dat").write_text("")
        storage_ref = {
            "backend": "local_file",
            "uuid": node_uuid,
            "filename": "x.dat",
            "format": "old_format_v1",
        }
        with pytest.raises(PDVSerializationError) as ei:
            deserialize_node(
                storage_ref,
                str(tmp_path),
                trusted=True,
                python_type="lostmethod_pkg.mod.Thing",
            )
        msg = str(ei.value)
        assert "old_format_v1" in msg
        assert "lostmethod_pkg.mod.Thing" in msg
        # Distinguishes from the missing-package branch: the message names
        # rename/removal/upgrade as the likely cause and does NOT tell the
        # user to install the (already-installed) package.
        assert "renamed" in msg.lower() or "dropped" in msg.lower()
        assert "install the defining package" not in msg.lower()
    finally:
        sys.path.remove(str(tmp_path))
        for k in list(sys.modules):
            if k.startswith("lostmethod_pkg"):
                del sys.modules[k]


# ---------------------------------------------------------------------------
# Additional error-path coverage (from PR review feedback).
# ---------------------------------------------------------------------------


def test_pdv_format_raising_is_wrapped():
    """``__pdv_format__()`` raising is caught and re-raised as
    ``PDVSerializationError`` naming the class and chaining the original."""

    class _BadFormat:
        @classmethod
        def __pdv_format__(cls):
            raise RuntimeError("format method broken")

        def __pdv_serialize__(self, path):
            open(path, "wb").write(b"")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls()

    with pytest.raises(PDVSerializationError) as ei:
        serializers.find_for_value_dunder(_BadFormat())
    msg = str(ei.value)
    assert "_BadFormat" in msg
    assert "__pdv_format__" in msg
    assert "format method broken" in msg
    assert isinstance(ei.value.__cause__, RuntimeError)


@pytest.mark.parametrize(
    "bad_return",
    [
        "not a tuple",
        ("missing extension",),
        ("too", "many", "parts"),
        (42, ".bin"),
        ("fmt", 42),
        (None, None),
    ],
)
def test_pdv_format_bad_return_raises(bad_return):
    """``__pdv_format__()`` must return ``(str, str)``. Anything else
    (wrong type, wrong arity, non-string elements) raises a descriptive
    error pointing at the class."""

    class _BadShape:
        @classmethod
        def __pdv_format__(cls):
            return bad_return

        def __pdv_serialize__(self, path):
            open(path, "wb").write(b"")

        @classmethod
        def __pdv_deserialize__(cls, path):
            return cls()

    with pytest.raises(PDVSerializationError, match="2-tuple"):
        serializers.find_for_value_dunder(_BadShape())


def test_find_for_format_dunder_resolves_nested_qualname(tmp_path, monkeypatch):
    """``find_for_format_dunder`` walks leftwards on import failures so a
    nested class like ``pkg.mod.Outer.Inner`` resolves correctly, and a
    second lookup hits the cache without re-importing."""
    pkg_dir = tmp_path / "nestedpkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "mod.py").write_text(textwrap.dedent("""
        class Outer:
            class Inner:
                @classmethod
                def __pdv_format__(cls):
                    return ("nested_v1", ".bin")

                def __pdv_serialize__(self, path):
                    open(path, "wb").write(b"")

                @classmethod
                def __pdv_deserialize__(cls, path):
                    return cls()
    """))

    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        cls, reason = serializers.find_for_format_dunder(
            "nested_v1", "nestedpkg.mod.Outer.Inner"
        )
        assert reason == serializers.LOOKUP_OK
        assert cls is not None
        assert cls.__qualname__ == "Outer.Inner"

        # Second call must hit the cache (verify by monkeypatching
        # importlib.import_module to fail — if the cache misses, we'd
        # observe the failure).
        import importlib as _importlib

        original_import = _importlib.import_module

        def _explode(name, *args, **kwargs):
            raise AssertionError(
                f"cache miss: import_module called for {name!r}"
            )

        monkeypatch.setattr(_importlib, "import_module", _explode)
        cls2, reason2 = serializers.find_for_format_dunder(
            "nested_v1", "nestedpkg.mod.Outer.Inner"
        )
        assert reason2 == serializers.LOOKUP_OK
        assert cls2 is cls
        monkeypatch.setattr(_importlib, "import_module", original_import)
    finally:
        for k in list(sys.modules):
            if k.startswith("nestedpkg"):
                del sys.modules[k]


def test_find_for_format_dunder_revalidates_cached_class(tmp_path, monkeypatch):
    """A cached class that has been hot-reloaded and lost
    ``__pdv_deserialize__`` is treated as a cache miss, so the caller
    observes ``LOOKUP_CLASS_UNLOADABLE`` rather than a stale hit that would
    later AttributeError on the dispatch site."""
    pkg_dir = tmp_path / "reloadpkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "mod.py").write_text(textwrap.dedent("""
        class Thing:
            @classmethod
            def __pdv_format__(cls):
                return ("reload_v1", ".bin")

            def __pdv_serialize__(self, path):
                open(path, "wb").write(b"")

            @classmethod
            def __pdv_deserialize__(cls, path):
                return cls()
    """))

    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        cls, reason = serializers.find_for_format_dunder(
            "reload_v1", "reloadpkg.mod.Thing"
        )
        assert reason == serializers.LOOKUP_OK
        assert cls is not None

        # Simulate a hot-reload that drops the dunder method.
        del cls.__pdv_deserialize__

        cls2, reason2 = serializers.find_for_format_dunder(
            "reload_v1", "reloadpkg.mod.Thing"
        )
        # On revalidation, the cache entry is dropped. The class is the
        # same identity (still in sys.modules) but no longer qualifies,
        # so the resolver walks through to LOOKUP_CLASS_UNLOADABLE.
        assert cls2 is None
        assert reason2 == serializers.LOOKUP_CLASS_UNLOADABLE
    finally:
        for k in list(sys.modules):
            if k.startswith("reloadpkg"):
                del sys.modules[k]


def test_legacy_descriptor_without_python_type_keeps_old_message(tmp_path):
    """When python_type is empty, the legacy error message fires verbatim."""
    node_uuid = "legacy_uuid"
    backing = tmp_path / "tree" / node_uuid
    backing.mkdir(parents=True, exist_ok=True)
    (backing / "x.bin").write_text("")
    storage_ref = {
        "backend": "local_file",
        "uuid": node_uuid,
        "filename": "x.bin",
        "format": "no_such_format",
    }
    with pytest.raises(PDVSerializationError) as ei:
        deserialize_node(storage_ref, str(tmp_path), trusted=True)
    msg = str(ei.value)
    # Legacy message names "Unsupported storage format" and the format, but
    # does NOT mention an empty python_type or "install".
    assert "no_such_format" in msg
    assert "''" not in msg  # no empty python_type leak
