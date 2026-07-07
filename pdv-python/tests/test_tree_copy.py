"""
pdv-python/tests/test_tree_copy.py — PDVTree copy/pickle/get consistency.

Regression tests for the dict-subclass holes fixed in the data-integrity
batch:

- ``copy.deepcopy``/``pickle`` raised ``TypeError: cannot pickle
  '_thread.lock' object`` because every instance carried a debounce lock
  and timer — which made ``pdv.tree.duplicate`` (folder duplication in
  the UI) fail unconditionally.
- ``dict.get`` was not dot-path aware, so ``tree.get('a.b')`` returned
  the default while ``tree['a.b']`` worked.
- ``dict.copy`` returned a plain ``dict``, silently dropping the PDVTree
  type and instance state.
- ``PDVTree({'a.b': 1})`` stored a literal dotted key that
  ``__getitem__`` could never retrieve.

The duplicate-handler test drives the real ``pdv.tree.duplicate`` entry
point via ``_on_comm_message`` — it is the shipping-bug regression.
"""

import copy
import pickle
import uuid as uuid_mod
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import pdv.comms as comms_mod
from pdv.errors import PDVKeyError, PDVPathError
from pdv.tree import PDVModule, PDVScript, PDVTree


class TestDeepcopyPickle:
    def _sample_tree(self) -> PDVTree:
        tree = PDVTree()
        tree["folder.data"] = [1, 2, 3]
        tree["folder.script"] = PDVScript(uuid="u1", filename="fit.py")
        tree["scalar"] = 42
        return tree

    def test_deepcopy_succeeds_and_is_independent(self):
        tree = self._sample_tree()
        clone = copy.deepcopy(tree["folder"])
        assert isinstance(clone, PDVTree)
        assert clone["data"] == [1, 2, 3]
        clone["data"].append(4)
        assert tree["folder.data"] == [1, 2, 3]

    def test_deepcopy_of_root_is_detached(self, tree_with_comm):
        tree_with_comm["a.b"] = 1
        clone = copy.deepcopy(tree_with_comm)
        assert clone._send_fn is None
        # Mutating the detached clone must not raise or notify precisely.
        clone["a.c"] = 2
        assert "a.c" not in tree_with_comm

    def test_pickle_roundtrip_items_and_attrs(self, tmp_working_dir):
        tree = self._sample_tree()
        tree._set_working_dir(tmp_working_dir)
        restored = pickle.loads(pickle.dumps(tree))
        assert isinstance(restored, PDVTree)
        assert restored["scalar"] == 42
        assert restored["folder.data"] == [1, 2, 3]
        assert isinstance(restored["folder.script"], PDVScript)
        assert restored["folder.script"].uuid == "u1"
        assert restored._working_dir == tmp_working_dir
        assert restored._send_fn is None

    def test_pickle_roundtrip_pdvmodule_subclass(self):
        mod = PDVModule(module_id="m1", name="Demo", version="1.0")
        mod["inputs.x"] = 3.5
        restored = pickle.loads(pickle.dumps(mod))
        assert isinstance(restored, PDVModule)
        assert restored.module_id == "m1"
        assert restored.name == "Demo"
        assert restored["inputs.x"] == 3.5

    def test_deepcopy_tree_nested_inside_plain_container(self):
        inner = PDVTree()
        inner["k"] = 1
        holder = {"trees": [inner]}
        clone = copy.deepcopy(holder)
        assert isinstance(clone["trees"][0], PDVTree)
        assert clone["trees"][0]["k"] == 1


class TestDuplicateHandlerEntryPoint:
    """Drive the real pdv.tree.duplicate handler (the shipping bug)."""

    def _dispatch(self, tree: PDVTree, msg_type: str, payload: dict) -> list[dict]:
        sent: list[dict[str, Any]] = []
        mock_comm = MagicMock()
        mock_comm.send.side_effect = lambda data: sent.append(data)
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            comms_mod._on_comm_message(
                {
                    "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
                    "msg_id": str(uuid_mod.uuid4()),
                    "in_reply_to": None,
                    "type": msg_type,
                    "payload": payload,
                }
            )
        return sent

    def test_duplicate_folder_node_succeeds(self, tree_with_comm):
        tree_with_comm["folder"] = PDVTree()
        tree_with_comm["folder.x"] = [1, 2]
        sent = self._dispatch(
            tree_with_comm,
            "pdv.tree.duplicate",
            {"path": "folder", "new_path": "folder_copy"},
        )
        responses = [e for e in sent if e.get("type") == "pdv.tree.duplicate.response"]
        assert responses, f"no duplicate response in {sent}"
        payload = responses[-1]["payload"]
        assert payload.get("duplicated") is True, payload
        assert isinstance(tree_with_comm["folder_copy"], PDVTree)
        assert tree_with_comm["folder_copy.x"] == [1, 2]
        # Deep copy: mutating the clone leaves the original untouched.
        tree_with_comm["folder_copy.x"].append(3)
        assert tree_with_comm["folder.x"] == [1, 2]

    def test_duplicate_missing_path_errors_cleanly(self, tree_with_comm):
        sent = self._dispatch(
            tree_with_comm,
            "pdv.tree.duplicate",
            {"path": "nope", "new_path": "copy"},
        )
        responses = [e for e in sent if e.get("type") == "pdv.tree.duplicate.response"]
        assert responses
        assert responses[-1]["status"] == "error"
        assert responses[-1]["payload"]["code"] == "tree.path_not_found"


class TestGetDotPath:
    def test_get_resolves_dot_paths(self):
        tree = PDVTree()
        tree["a.b"] = 42
        assert tree.get("a.b") == 42
        assert tree.get("a.b") == tree["a.b"]

    def test_get_returns_default_for_missing(self):
        tree = PDVTree()
        assert tree.get("missing") is None
        assert tree.get("missing", 5) == 5
        assert tree.get("a.b.c", "d") == "d"

    def test_get_plain_key_still_works(self):
        tree = PDVTree()
        tree["top"] = "v"
        assert tree.get("top") == "v"


class TestCopyOverride:
    def test_copy_preserves_type_and_state(self, tmp_working_dir):
        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        tree["a.b"] = 1
        c = tree.copy()
        assert type(c) is PDVTree
        assert c._working_dir == tmp_working_dir
        assert c["a.b"] == 1

    def test_copy_is_shallow_and_detached(self, tree_with_comm):
        tree_with_comm["a"] = [1]
        c = tree_with_comm.copy()
        assert c._send_fn is None
        assert c["a"] is tree_with_comm["a"]

    def test_copy_preserves_subclass(self):
        mod = PDVModule(module_id="m1", name="Demo", version="1.0")
        mod["k"] = 1
        c = mod.copy()
        assert type(c) is PDVModule
        assert c.module_id == "m1"
        assert c["k"] == 1


class TestConstructorNormalization:
    def test_dotted_keys_expand_to_nested_nodes(self):
        tree = PDVTree({"a.b": 1})
        assert tree["a.b"] == 1
        assert isinstance(tree["a"], PDVTree)
        assert dict.__contains__(tree, "a")
        assert not dict.__contains__(tree, "a.b")

    def test_plain_mapping_and_kwargs(self):
        tree = PDVTree({"x": 1}, y=2)
        assert tree["x"] == 1
        assert tree["y"] == 2

    def test_non_string_keys_rejected(self):
        with pytest.raises((PDVPathError, PDVKeyError, TypeError)):
            PDVTree({1: "one"})

    def test_roundtrip_getitem_contains_get_agree(self):
        tree = PDVTree({"a.b": 1})
        assert "a.b" in tree
        assert tree.get("a.b") == 1
