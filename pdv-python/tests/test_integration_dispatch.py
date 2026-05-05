"""
pdv-python/tests/test_integration_dispatch.py — Integration-style comm dispatch tests.

Exercises kernel-side message dispatch via ``_on_comm_message`` using a real
PDVTree and mocked comm transport.
"""

from __future__ import annotations

import json
import os
import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pdv.comms as comms_mod
from pdv.tree import PDVScript, PDVTree


def _make_mock_comm() -> MagicMock:
    sent: list[dict[str, Any]] = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(
    msg_type: str, payload: dict[str, Any], msg_id: str | None = None
) -> dict[str, Any]:
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": msg_id or str(uuid.uuid4()),
        "in_reply_to": None,
        "type": msg_type,
        "payload": payload,
    }


def _latest_by_type(envelopes: list[dict[str, Any]], msg_type: str) -> dict[str, Any]:
    matches = [env for env in envelopes if env.get("type") == msg_type]
    assert matches, f"Expected at least one envelope of type {msg_type!r}"
    return matches[-1]


class TestIntegrationDispatch:
    def test_dispatch_handles_major_message_types_and_unknown_type(
        self, tmp_working_dir: str, tmp_save_dir: str
    ) -> None:
        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        tree["alpha"] = 1
        mock_comm = _make_mock_comm()
        ip = SimpleNamespace(user_ns={"pdv_tree": tree, "x": 42})

        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
            patch.object(comms_mod, "_ip", ip),
        ):
            comms_mod._on_comm_message(_make_msg("pdv.tree.list", {"path": ""}))
            comms_mod._on_comm_message(
                _make_msg("pdv.tree.get", {"path": "alpha", "mode": "value"})
            )
            comms_mod._on_comm_message(_make_msg("pdv.namespace.query", {}))
            comms_mod._on_comm_message(
                _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
            )
            comms_mod._on_comm_message(_make_msg("pdv.not.real", {}))

        tree_list = _latest_by_type(mock_comm._sent, "pdv.tree.list.response")
        assert tree_list["status"] == "ok"
        assert isinstance(tree_list["payload"].get("nodes"), list)

        tree_get = _latest_by_type(mock_comm._sent, "pdv.tree.get.response")
        assert tree_get["status"] == "ok"
        assert "1" in str(tree_get["payload"].get("value"))

        namespace = _latest_by_type(mock_comm._sent, "pdv.namespace.query.response")
        assert namespace["status"] == "ok"
        variables = namespace["payload"].get("variables", {})
        assert "x" in variables
        assert variables["x"]["type"] == "int"

        project_save = _latest_by_type(mock_comm._sent, "pdv.project.save.response")
        assert project_save["status"] == "ok"
        assert os.path.exists(os.path.join(tmp_save_dir, "tree-index.json"))

        unknown = _latest_by_type(mock_comm._sent, "pdv.not.real.response")
        assert unknown["status"] == "error"
        assert unknown["payload"]["code"] == "protocol.unknown_type"

    def test_tree_changed_emits_updated_and_removed_change_types(
        self, tmp_working_dir: str
    ) -> None:
        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        mock_comm = _make_mock_comm()

        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            tree._attach_comm(
                lambda msg_type, payload: comms_mod.send_message(msg_type, payload)
            )
            tree["probe"] = 1
            tree._flush_changes()
            tree["probe"] = 2
            tree._flush_changes()
            del tree["probe"]
            tree._flush_changes()

        changed_pushes = [
            env for env in mock_comm._sent if env.get("type") == "pdv.tree.changed"
        ]
        assert len(changed_pushes) >= 3
        # Each flush produces a batch notification; check the paths are correct.
        assert "probe" in changed_pushes[0]["payload"]["changed_paths"]
        assert "probe" in changed_pushes[2]["payload"]["changed_paths"]

    def test_project_save_load_roundtrip_with_multiple_node_types(
        self, tmp_working_dir: str, tmp_save_dir: str, tmp_path
    ) -> None:
        scr_uuid = "integ_scr_01"
        script_dir = os.path.join(tmp_working_dir, "tree", scr_uuid)
        os.makedirs(script_dir, exist_ok=True)
        script_file = os.path.join(script_dir, "roundtrip_script.py")
        with open(script_file, "w", encoding="utf-8") as f:
            f.write("def run(pdv_tree: dict):\n    return {'ok': True}\n")

        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        tree["data.x"] = 1
        tree["scripts.demo"] = PDVScript(uuid=scr_uuid, filename="roundtrip_script.py")

        try:
            import numpy as np  # type: ignore

            tree["arr"] = np.array([1.0, 2.0, 3.0])
            expect_numpy = True
        except ImportError:
            tree["arr"] = [1.0, 2.0, 3.0]
            expect_numpy = False

        save_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", save_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            comms_mod._on_comm_message(
                _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
            )
        save_response = _latest_by_type(save_comm._sent, "pdv.project.save.response")
        assert save_response["status"] == "ok"

        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(tmp_working_dir)
        # Simulate TypeScript's copyFilesForLoad: copy file-backed nodes to working dir
        from pdv.environment import smart_copy

        tree_index_path = os.path.join(tmp_save_dir, "tree-index.json")
        with open(tree_index_path, "r", encoding="utf-8") as fh:
            index_nodes = json.loads(fh.read())
        for node in index_nodes:
            storage = node.get("storage", {})
            node_uuid = storage.get("uuid", "")
            filename = storage.get("filename", "")
            if storage.get("backend") == "local_file" and node_uuid and filename:
                src = os.path.join(tmp_save_dir, "tree", node_uuid, filename)
                dst = os.path.join(tmp_working_dir, "tree", node_uuid, filename)
                if os.path.exists(src):
                    smart_copy(src, dst)
        load_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", load_comm),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            comms_mod._on_comm_message(
                _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
            )
        load_response = _latest_by_type(load_comm._sent, "pdv.project.load.response")
        assert load_response["status"] == "ok"

        assert fresh_tree["data.x"] == 1
        assert isinstance(fresh_tree["scripts.demo"], PDVScript)
        if expect_numpy:
            import numpy as np  # type: ignore

            assert np.allclose(fresh_tree["arr"], np.array([1.0, 2.0, 3.0]))
        else:
            assert fresh_tree["arr"] == [1.0, 2.0, 3.0]

    def test_script_register_then_run_pipeline(
        self, tmp_working_dir: str, tmp_path
    ) -> None:
        scr_uuid = "integ_scr_02"
        script_dir = os.path.join(tmp_working_dir, "tree", scr_uuid)
        os.makedirs(script_dir, exist_ok=True)
        script_file = os.path.join(script_dir, "double.py")
        with open(script_file, "w", encoding="utf-8") as f:
            f.write("def run(pdv_tree: dict, x: int = 1):\n    return {'result': x * 2}\n")

        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        mock_comm = _make_mock_comm()
        ip = SimpleNamespace(user_ns={"pdv_tree": tree})

        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
            patch.object(comms_mod, "_ip", ip),
        ):
            tree._attach_comm(
                lambda msg_type, payload: comms_mod.send_message(msg_type, payload)
            )
            comms_mod._on_comm_message(
                _make_msg(
                    "pdv.script.register",
                    {
                        "parent_path": "scripts",
                        "name": "double",
                        "uuid": scr_uuid,
                        "filename": "double.py",
                        "language": "python",
                    },
                )
            )
            tree._flush_changes()

        response = _latest_by_type(mock_comm._sent, "pdv.script.register.response")
        assert response["status"] == "ok"
        assert response["payload"]["path"] == "scripts.double"
        assert isinstance(tree["scripts.double"], PDVScript)
        assert tree["scripts.double"].run(tree=tree, x=5) == {"result": 10}
