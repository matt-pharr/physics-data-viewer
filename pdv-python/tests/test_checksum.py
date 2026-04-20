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
        from pdv.checksum import _node_digest

        child_via_root = _node_digest(child, None).hex()

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
        script_file = tmp_path / "script.py"
        script_file.write_text("def run(pdv_tree):\n    return {}\n", encoding="utf-8")

        tree = PDVTree()
        tree._set_working_dir(str(tmp_path))
        script = PDVScript(relative_path="script.py")
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
        script = PDVScript(relative_path="nonexistent.py")
        dict.__setitem__(tree, "s", script)

        # Should not raise
        checksum = tree_checksum(tree)
        assert len(checksum) == 32


class TestRelativePathNotHashed:
    """Regression test for a long-standing bug where tree_checksum folded
    ``relative_path`` into the digest of file-backed nodes, so any PDVScript
    / PDVGui / PDVNamelist / PDVNote checksum drifted after save/load
    because ``serialize_node`` rewrites the stored rel-path (``hello.py`` →
    ``tree/hello.py``) but leaves the in-memory node untouched. See task #12
    of the #140 module editing workflow.

    The fix removes ``relative_path`` from the hash inputs — it's a storage
    layout detail, not part of node identity. Content is still hashed in
    full via ``_feed_file_content``, and the parent folder's key iteration
    folds the tree path into the digest.
    """

    def test_script_checksum_ignores_relative_path(self, tmp_path):
        """Two PDVScripts pointing at the same content via different rel paths hash identically."""
        file_a = tmp_path / "a.py"
        file_b_dir = tmp_path / "tree"
        file_b_dir.mkdir()
        file_b = file_b_dir / "a.py"
        content = "def run(pdv_tree):\n    return {}\n"
        file_a.write_text(content, encoding="utf-8")
        file_b.write_text(content, encoding="utf-8")

        tree_a = PDVTree()
        tree_a._set_working_dir(str(tmp_path))
        dict.__setitem__(tree_a, "s", PDVScript(relative_path="a.py"))

        tree_b = PDVTree()
        tree_b._set_working_dir(str(tmp_path))
        dict.__setitem__(tree_b, "s", PDVScript(relative_path="tree/a.py"))

        assert tree_checksum(tree_a) == tree_checksum(tree_b)

    def test_script_checksum_still_content_sensitive(self, tmp_path):
        """Removing relative_path from the hash must not weaken content sensitivity."""
        file_a = tmp_path / "a.py"
        file_a.write_text("VERSION = 1\n", encoding="utf-8")

        tree = PDVTree()
        tree._set_working_dir(str(tmp_path))
        dict.__setitem__(tree, "s", PDVScript(relative_path="a.py"))
        before = tree_checksum(tree)

        file_a.write_text("VERSION = 2\n", encoding="utf-8")
        after = tree_checksum(tree)
        assert before != after


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

        script_file = os.path.join(working_dir, "hello.py")
        with open(script_file, "w", encoding="utf-8") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")
        dict.__setitem__(
            tree,
            "hello",
            PDVScript(relative_path="hello.py", language="python"),
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
