"""
pdv-python/tests/test_checksum.py — Tests for pdv.checksum.

Tests cover:
1. test_empty_tree_is_stable — same digest on two calls to an empty tree.
2. test_scalar_types_are_distinct — None, False, 0, 0.0, "" all differ.
3. test_key_order_independence — insertion order does not affect the digest.
4. test_subtree_digest_matches_root — child digest matches direct call.
5. test_ndarray_content_sensitivity — changing one element changes digest.
6. test_file_backed_node_content_sensitivity — file content is hashed.
7. test_roundtrip — save/load round-trip preserves the checksum.
"""

import os
from unittest.mock import MagicMock, patch

import pytest

import pdv.comms as comms_mod
from pdv.checksum import tree_checksum
from pdv.handlers.project import handle_project_load, handle_project_save
from pdv.tree import PDVTree, PDVScript


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tree(**items) -> PDVTree:
    t = PDVTree()
    for k, v in items.items():
        dict.__setitem__(t, k, v)
    return t


def _make_msg(msg_type, payload):
    import uuid

    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": str(uuid.uuid4()),
        "in_reply_to": None,
        "type": msg_type,
        "payload": payload,
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestEmptyTreeIsStable:
    def test_empty_tree_is_stable(self):
        """tree_checksum returns the same 64-char hex string on repeated calls."""
        tree = PDVTree()
        d1 = tree_checksum(tree)
        d2 = tree_checksum(tree)
        assert d1 == d2
        assert len(d1) == 32
        assert all(c in "0123456789abcdef" for c in d1)


class TestScalarTypesAreDistinct:
    def test_scalar_types_are_distinct(self):
        """None, False, 0, 0.0, and '' all produce different digests."""
        values = [None, False, 0, 0.0, ""]
        digests = []
        for v in values:
            tree = _make_tree(x=v)
            digests.append(tree_checksum(tree))
        assert len(set(digests)) == len(values), (
            "Not all scalar-type digests are distinct"
        )


class TestKeyOrderIndependence:
    def test_key_order_independence(self):
        """Trees with the same keys/values give the same digest regardless of
        insertion order."""
        t1 = PDVTree()
        dict.__setitem__(t1, "a", 1)
        dict.__setitem__(t1, "b", 2)
        dict.__setitem__(t1, "c", 3)

        t2 = PDVTree()
        dict.__setitem__(t2, "c", 3)
        dict.__setitem__(t2, "a", 1)
        dict.__setitem__(t2, "b", 2)

        assert tree_checksum(t1) == tree_checksum(t2)


class TestSubtreeDigestMatchesRoot:
    def test_subtree_digest_matches_root(self):
        """The digest of a child PDVTree equals tree_checksum called on it directly."""
        child = PDVTree()
        dict.__setitem__(child, "x", 42)
        dict.__setitem__(child, "y", "hello")

        root = PDVTree()
        dict.__setitem__(root, "sub", child)

        # Compute digest of child via the root traversal
        from pdv.checksum import node_digest

        child_via_root = node_digest(child, None).hex()

        # Compute directly
        child_direct = tree_checksum(child)

        assert child_via_root == child_direct


class TestNdarrayContentSensitivity:
    def test_ndarray_content_sensitivity(self):
        """Changing one element of an ndarray changes the tree checksum."""
        np = pytest.importorskip("numpy")

        arr1 = np.array([1.0, 2.0, 3.0])
        arr2 = np.array([1.0, 2.0, 9.9])

        t1 = _make_tree(arr=arr1)
        t2 = _make_tree(arr=arr2)

        assert tree_checksum(t1) != tree_checksum(t2)


class TestFileBackedNodeContentSensitivity:
    def test_file_backed_node_content_sensitivity(self, tmp_path):
        """Changing the content of a script file changes the checksum."""
        node_uuid = "chk_uuid_001"
        script_dir = tmp_path / "tree" / node_uuid
        script_dir.mkdir(parents=True)
        script_file = script_dir / "script.py"
        script_file.write_text("def run(pdv_tree):\n    return {}\n", encoding="utf-8")

        tree = PDVTree()
        tree._set_working_dir(str(tmp_path))
        script = PDVScript(uuid=node_uuid, filename="script.py")
        dict.__setitem__(tree, "s", script)

        checksum_before = tree_checksum(tree)

        # Modify the file content
        script_file.write_text(
            "def run(pdv_tree):\n    return {'x': 1}\n", encoding="utf-8"
        )

        checksum_after = tree_checksum(tree)

        assert checksum_before != checksum_after

    def test_missing_file_feeds_sentinel(self, tmp_path):
        """A missing script file does not raise; it feeds the sentinel value."""
        tree = PDVTree()
        tree._set_working_dir(str(tmp_path))
        script = PDVScript(uuid="missing_uuid1", filename="nonexistent.py")
        dict.__setitem__(tree, "s", script)

        # Should not raise
        checksum = tree_checksum(tree)
        assert len(checksum) == 32


class TestUuidNotHashed:
    """Regression test: the UUID is a storage layout detail — it must NOT
    be folded into the content hash. Two scripts with different UUIDs but
    identical file content must produce the same checksum.
    """

    def test_script_checksum_ignores_uuid(self, tmp_path):
        """Two PDVScripts with different UUIDs but same content hash identically."""
        uuid_a = "chk_uuid_a01"
        uuid_b = "chk_uuid_b01"
        content = "def run(pdv_tree):\n    return {}\n"
        for u in (uuid_a, uuid_b):
            d = tmp_path / "tree" / u
            d.mkdir(parents=True)
            (d / "a.py").write_text(content, encoding="utf-8")

        tree_a = PDVTree()
        tree_a._set_working_dir(str(tmp_path))
        dict.__setitem__(tree_a, "s", PDVScript(uuid=uuid_a, filename="a.py"))

        tree_b = PDVTree()
        tree_b._set_working_dir(str(tmp_path))
        dict.__setitem__(tree_b, "s", PDVScript(uuid=uuid_b, filename="a.py"))

        assert tree_checksum(tree_a) == tree_checksum(tree_b)

    def test_script_checksum_still_content_sensitive(self, tmp_path):
        """UUID exclusion must not weaken content sensitivity."""
        node_uuid = "chk_uuid_c01"
        d = tmp_path / "tree" / node_uuid
        d.mkdir(parents=True)
        f = d / "a.py"
        f.write_text("VERSION = 1\n", encoding="utf-8")

        tree = PDVTree()
        tree._set_working_dir(str(tmp_path))
        dict.__setitem__(tree, "s", PDVScript(uuid=node_uuid, filename="a.py"))
        before = tree_checksum(tree)

        f.write_text("VERSION = 2\n", encoding="utf-8")
        after = tree_checksum(tree)
        assert before != after


class TestAutosaveCache:
    """Tests for the per-node autosave cache used by ``serialize_node``.

    The cache is a ``dict[tree_path, (digest, descriptor)]`` keyed on tree
    path. On each serialize call, the node's content digest is recomputed
    and compared against the cached digest. Matches reuse the previous
    descriptor (same UUID, no file rewrite) and increment ``hit_counter[0]``.
    """

    def test_cache_hit_on_unchanged_ndarray(self, tmp_path):
        """Re-serializing the same ndarray reuses the cached descriptor."""
        np = pytest.importorskip("numpy")
        from pdv.serialization import serialize_node

        working_dir = str(tmp_path)
        cache: dict = {}
        hits = [0]
        arr = np.array([1.0, 2.0, 3.0])

        first = serialize_node(
            "x", arr, working_dir, autosave_cache=cache, autosave_hits=hits
        )
        assert hits[0] == 0  # first call is a miss
        assert "x" in cache

        second = serialize_node(
            "x", arr, working_dir, autosave_cache=cache, autosave_hits=hits
        )
        assert hits[0] == 1  # second call hits the cache
        # Cache hit must reuse the existing descriptor (same UUID).
        assert second["uuid"] == first["uuid"]

    def test_cache_miss_after_array_mutation(self, tmp_path):
        """Modifying the array's contents invalidates the cache entry."""
        np = pytest.importorskip("numpy")
        from pdv.serialization import serialize_node

        working_dir = str(tmp_path)
        cache: dict = {}
        hits = [0]

        arr1 = np.array([1.0, 2.0, 3.0])
        first = serialize_node(
            "x", arr1, working_dir, autosave_cache=cache, autosave_hits=hits
        )

        arr2 = np.array([1.0, 2.0, 9.9])  # one element differs
        second = serialize_node(
            "x", arr2, working_dir, autosave_cache=cache, autosave_hits=hits
        )

        assert hits[0] == 0  # never hit
        assert second["uuid"] != first["uuid"]  # fresh UUID written
        # Cache should now hold the *new* descriptor.
        assert cache["x"][1]["uuid"] == second["uuid"]

    def test_cache_disabled_when_none(self, tmp_path):
        """``autosave_cache=None`` disables caching — every call is a miss."""
        np = pytest.importorskip("numpy")
        from pdv.serialization import serialize_node

        working_dir = str(tmp_path)
        hits = [0]
        arr = np.array([1.0, 2.0, 3.0])

        first = serialize_node(
            "x", arr, working_dir, autosave_cache=None, autosave_hits=hits
        )
        second = serialize_node(
            "x", arr, working_dir, autosave_cache=None, autosave_hits=hits
        )

        assert hits[0] == 0
        # Without a cache, each serialization writes a fresh node.
        assert second["uuid"] != first["uuid"]

    def test_cache_keyed_by_tree_path(self, tmp_path):
        """Identical values at different paths are cached independently."""
        np = pytest.importorskip("numpy")
        from pdv.serialization import serialize_node

        working_dir = str(tmp_path)
        cache: dict = {}
        hits = [0]
        arr = np.array([1.0, 2.0, 3.0])

        a = serialize_node(
            "a", arr, working_dir, autosave_cache=cache, autosave_hits=hits
        )
        b = serialize_node(
            "b", arr, working_dir, autosave_cache=cache, autosave_hits=hits
        )

        # Different paths → two independent cache entries, neither a hit.
        assert hits[0] == 0
        assert a["uuid"] != b["uuid"]
        assert set(cache.keys()) == {"a", "b"}

    def test_cache_populated_by_explicit_save_persists_into_autosave(self, tmp_path):
        """Two-phase test mirroring the saved-project disk-doubling fix.

        First call simulates an explicit save: cache empty on entry, gets
        populated with `(digest, descriptor)` entries. Second call
        simulates a follow-up autosave that shares the same cache; every
        unchanged data node should hit the cache (no fresh write to the
        autosave dir, descriptor reused — referencing the original UUID).
        """
        np = pytest.importorskip("numpy")
        from pdv.serialization import serialize_node

        save_dir = str(tmp_path / "save")
        autosave_dir = str(tmp_path / "save" / ".autosave")

        cache: dict = {}
        hits = [0]
        arr = np.array([1.0, 2.0, 3.0])

        # Explicit-save phase: writes under save_dir, populates cache.
        first = serialize_node(
            "x", arr, save_dir, autosave_cache=cache, autosave_hits=hits
        )
        assert hits[0] == 0  # first call always misses
        assert "x" in cache

        # Autosave phase: cache has an entry from the explicit save. With
        # the same array value, this is a cache hit and the returned
        # descriptor still references the canonical (save_dir) UUID — so
        # autosave's tree-index references the canonical file and avoids
        # writing a duplicate copy under autosave_dir/tree/.
        second = serialize_node(
            "x", arr, autosave_dir, autosave_cache=cache, autosave_hits=hits
        )
        assert hits[0] == 1
        assert second["uuid"] == first["uuid"]

        # The autosave dir must NOT have a tree/ subdir for this node — the
        # whole point of the fix is that we skip the write when the cache
        # hits.
        import os
        autosave_tree = os.path.join(autosave_dir, "tree", second["uuid"])
        assert not os.path.exists(autosave_tree), (
            f"autosave duplicated the canonical file at {autosave_tree}"
        )


class TestRoundtrip:
    def test_roundtrip(self, tmp_path):
        """Save a tree to disk and reload it; tree_checksum must be equal."""
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir, exist_ok=True)
        os.makedirs(save_dir, exist_ok=True)

        # Build a tree with a mix of value types — including a file-backed
        # PDVScript so the test exercises the branch that used to fold
        # relative_path into the digest (see TestRelativePathNotHashed).
        tree = PDVTree()
        tree._set_working_dir(working_dir)

        subtree = PDVTree()
        dict.__setitem__(subtree, "count", 7)
        dict.__setitem__(subtree, "label", "hello")
        dict.__setitem__(tree, "sub", subtree)
        dict.__setitem__(tree, "value", 3.14)
        dict.__setitem__(tree, "flag", True)
        dict.__setitem__(tree, "items", [1, 2, 3])

        hello_uuid = "chk_hello_01"
        script_dir = os.path.join(working_dir, "tree", hello_uuid)
        os.makedirs(script_dir, exist_ok=True)
        script_file = os.path.join(script_dir, "hello.py")
        with open(script_file, "w", encoding="utf-8") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")
        dict.__setitem__(
            tree,
            "hello",
            PDVScript(uuid=hello_uuid, filename="hello.py", language="python"),
        )

        checksum_before = tree_checksum(tree)

        # ---- save ----
        mock_comm = MagicMock()
        sent: list = []
        mock_comm.send.side_effect = lambda data: sent.append(data)
        save_msg = _make_msg("pdv.project.save", {"save_dir": save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_project_save(save_msg)

        # Confirm save emitted a response with a checksum
        save_resp = next(
            (m for m in sent if m.get("type") == "pdv.project.save.response"), None
        )
        assert save_resp is not None
        assert save_resp["payload"]["checksum"] == checksum_before

        # ---- simulate main-process copyFilesForLoad ----
        # The real app mirrors saveDir/tree/ back into workingDir/tree/
        # before calling pdv.project.load so the rehydrated PDVFile nodes
        # can resolve their new tree-prefixed relative paths on disk.
        import shutil

        save_tree = os.path.join(save_dir, "tree")
        if os.path.exists(save_tree):
            shutil.copytree(
                save_tree,
                os.path.join(working_dir, "tree"),
                dirs_exist_ok=True,
            )

        # ---- load into a fresh tree ----
        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(working_dir)

        sent.clear()
        load_msg = _make_msg("pdv.project.load", {"save_dir": save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(load_msg)

        # The post-load response should carry the same checksum
        load_resp = next(
            (m for m in sent if m.get("type") == "pdv.project.load.response"), None
        )
        assert load_resp is not None
        post_load_checksum = load_resp["payload"]["post_load_checksum"]

        checksum_after = tree_checksum(fresh_tree)

        assert checksum_after == checksum_before
        assert post_load_checksum == checksum_before
