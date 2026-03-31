"""
pdv-python/tests/test_checksum.py — Tests for pdv_kernel.checksum.

Tests cover:
1. test_empty_tree_is_stable — same digest on two calls to an empty tree.
2. test_scalar_types_are_distinct — None, False, 0, 0.0, "" all differ.
3. test_key_order_independence — insertion order does not affect the digest.
4. test_subtree_digest_matches_root — child digest matches direct call.
5. test_ndarray_content_sensitivity — changing one element changes digest.
6. test_file_backed_node_content_sensitivity — file content is hashed.
7. test_roundtrip — save/load round-trip preserves the checksum.
"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

import pdv_kernel.comms as comms_mod
from pdv_kernel.checksum import tree_checksum
from pdv_kernel.handlers.project import handle_project_load, handle_project_save
from pdv_kernel.tree import PDVTree, PDVScript


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
        from pdv_kernel.checksum import _node_digest
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
        script_file.write_text("def run(pdv_tree):\n    return {'x': 1}\n", encoding="utf-8")

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


class TestRoundtrip:
    def test_roundtrip(self, tmp_path):
        """Save a tree to disk and reload it; tree_checksum must be equal."""
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir, exist_ok=True)
        os.makedirs(save_dir, exist_ok=True)

        # Build a tree with a mix of value types
        tree = PDVTree()
        tree._set_working_dir(working_dir)

        subtree = PDVTree()
        dict.__setitem__(subtree, "count", 7)
        dict.__setitem__(subtree, "label", "hello")
        dict.__setitem__(tree, "sub", subtree)
        dict.__setitem__(tree, "value", 3.14)
        dict.__setitem__(tree, "flag", True)
        dict.__setitem__(tree, "items", [1, 2, 3])

        checksum_before = tree_checksum(tree)

        # ---- save ----
        mock_comm = MagicMock()
        sent: list = []
        mock_comm.send.side_effect = lambda data: sent.append(data)
        save_msg = _make_msg("pdv.project.save", {"save_dir": save_dir})
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            handle_project_save(save_msg)

        # Confirm save emitted a response with a checksum
        save_resp = next(
            (m for m in sent if m.get("type") == "pdv.project.save.response"), None
        )
        assert save_resp is not None
        assert save_resp["payload"]["checksum"] == checksum_before

        # ---- load into a fresh tree ----
        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(working_dir)

        sent.clear()
        load_msg = _make_msg("pdv.project.load", {"save_dir": save_dir})
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", fresh_tree):
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
