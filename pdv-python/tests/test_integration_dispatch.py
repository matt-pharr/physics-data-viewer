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

import pdv_kernel.comms as comms_mod
from pdv_kernel.namespace import PDVApp
from pdv_kernel.tree import PDVScript, PDVTree


def _make_mock_comm() -> MagicMock:
    sent: list[dict[str, Any]] = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(msg_type: str, payload: dict[str, Any], msg_id: str | None = None) -> dict[str, Any]:
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
        ip = SimpleNamespace(user_ns={"pdv_tree": tree, "pdv": PDVApp(), "x": 42})

        with patch.object(comms_mod, "_comm", mock_comm), patch.object(
            comms_mod, "_pdv_tree", tree
        ), patch.object(comms_mod, "_ip", ip):
            comms_mod._on_comm_message(_make_msg("pdv.tree.list", {"path": ""}))
            comms_mod._on_comm_message(_make_msg("pdv.tree.get", {"path": "alpha", "mode": "value"}))
            comms_mod._on_comm_message(_make_msg("pdv.namespace.query", {}))
            comms_mod._on_comm_message(_make_msg("pdv.project.save", {"save_dir": tmp_save_dir}))
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

    def test_tree_changed_emits_updated_and_removed_change_types(self, tmp_working_dir: str) -> None:
        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        mock_comm = _make_mock_comm()

        with patch.object(comms_mod, "_comm", mock_comm), patch.object(comms_mod, "_pdv_tree", tree):
            tree._attach_comm(lambda msg_type, payload: comms_mod.send_message(msg_type, payload))
            tree["probe"] = 1
            tree["probe"] = 2
            del tree["probe"]

        changed_pushes = [env for env in mock_comm._sent if env.get("type") == "pdv.tree.changed"]
        assert len(changed_pushes) >= 3
        assert changed_pushes[1]["payload"]["change_type"] == "updated"
        assert changed_pushes[2]["payload"]["change_type"] == "removed"
        assert changed_pushes[2]["payload"]["changed_paths"] == ["probe"]

    def test_project_save_load_roundtrip_with_multiple_node_types(
        self, tmp_working_dir: str, tmp_save_dir: str, tmp_path
    ) -> None:
        script_file = tmp_path / "roundtrip_script.py"
        script_file.write_text("def run(pdv_tree: dict):\n    return {'ok': True}\n", encoding="utf-8")

        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        tree["data.x"] = 1
        tree["scripts.demo"] = PDVScript(relative_path=str(script_file))

        try:
            import numpy as np  # type: ignore

            tree["arr"] = np.array([1.0, 2.0, 3.0])
            expect_numpy = True
        except ImportError:
            tree["arr"] = [1.0, 2.0, 3.0]
            expect_numpy = False

        save_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", save_comm), patch.object(comms_mod, "_pdv_tree", tree):
            comms_mod._on_comm_message(_make_msg("pdv.project.save", {"save_dir": tmp_save_dir}))
        save_response = _latest_by_type(save_comm._sent, "pdv.project.save.response")
        assert save_response["status"] == "ok"

        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(tmp_working_dir)
        # Simulate TypeScript's copyFilesForLoad: copy file-backed nodes to working dir
        import shutil
        tree_index_path = os.path.join(tmp_save_dir, "tree-index.json")
        with open(tree_index_path, "r", encoding="utf-8") as fh:
            index_nodes = json.loads(fh.read())
        for node in index_nodes:
            storage = node.get("storage", {})
            rel = storage.get("relative_path", "")
            if storage.get("backend") == "local_file" and rel:
                src = os.path.join(tmp_save_dir, rel)
                dst = os.path.join(tmp_working_dir, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if os.path.exists(src):
                    shutil.copy2(src, dst)
        load_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", load_comm), patch.object(comms_mod, "_pdv_tree", fresh_tree):
            comms_mod._on_comm_message(_make_msg("pdv.project.load", {"save_dir": tmp_save_dir}))
        load_response = _latest_by_type(load_comm._sent, "pdv.project.load.response")
        assert load_response["status"] == "ok"

        assert fresh_tree["data.x"] == 1
        assert isinstance(fresh_tree["scripts.demo"], PDVScript)
        if expect_numpy:
            import numpy as np  # type: ignore

            assert np.allclose(fresh_tree["arr"], np.array([1.0, 2.0, 3.0]))
        else:
            assert fresh_tree["arr"] == [1.0, 2.0, 3.0]

    def test_script_register_then_run_pipeline(self, tmp_working_dir: str, tmp_path) -> None:
        script_file = tmp_path / "double.py"
        script_file.write_text(
            "def run(pdv_tree: dict, x: int = 1):\n    return {'result': x * 2}\n",
            encoding="utf-8",
        )

        tree = PDVTree()
        tree._set_working_dir(tmp_working_dir)
        mock_comm = _make_mock_comm()
        ip = SimpleNamespace(user_ns={"pdv_tree": tree, "pdv": PDVApp()})

        with patch.object(comms_mod, "_comm", mock_comm), patch.object(
            comms_mod, "_pdv_tree", tree
        ), patch.object(comms_mod, "_ip", ip):
            tree._attach_comm(lambda msg_type, payload: comms_mod.send_message(msg_type, payload))
            comms_mod._on_comm_message(
                _make_msg(
                    "pdv.script.register",
                    {
                        "parent_path": "scripts",
                        "name": "double",
                        "relative_path": str(script_file),
                        "language": "python",
                    },
                )
            )

        response = _latest_by_type(mock_comm._sent, "pdv.script.register.response")
        assert response["status"] == "ok"
        assert response["payload"]["path"] == "scripts.double"
        assert isinstance(tree["scripts.double"], PDVScript)
        assert tree["scripts.double"].run(tree=tree, x=5) == {"result": 10}
