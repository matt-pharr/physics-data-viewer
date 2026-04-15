"""
pdv-python/tests/test_handlers_script.py — Tests for pdv.script.register handler.
"""

import uuid
from unittest.mock import MagicMock, patch

import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.script import handle_script_register
from pdv_kernel.tree import PDVScript, PDVTree


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(payload, msg_id=None):
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": msg_id or str(uuid.uuid4()),
        "in_reply_to": None,
        "type": "pdv.script.register",
        "payload": payload,
    }


class TestHandleScriptRegister:
    def test_valid_register_attaches_script_to_tree(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            {
                "parent_path": "scripts.analysis",
                "name": "fit_model",
                "relative_path": "scripts/analysis/fit_model.py",
                "language": "python",
            }
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_script_register(msg)

        node = tree["scripts.analysis.fit_model"]
        assert isinstance(node, PDVScript)
        assert node.relative_path == "scripts/analysis/fit_model.py"
        response = mock_comm._sent[-1]
        assert response["type"] == "pdv.script.register.response"
        assert response["status"] == "ok"
        assert response["payload"]["path"] == "scripts.analysis.fit_model"

    def test_register_with_source_rel_path_persists_on_node(self):
        """source_rel_path from payload is stored on the PDVScript node.

        Regression guard for workflow A/B: module-owned scripts created
        via pdv.script.register must remember where they belong inside
        <saveDir>/modules/<id>/ so the save-time sync can mirror edits.
        """
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            {
                "parent_path": "my_mod.scripts",
                "name": "solve",
                "relative_path": "my_mod/scripts/solve.py",
                "language": "python",
                "module_id": "my_mod",
                "source_rel_path": "scripts/solve.py",
            }
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_script_register(msg)

        node = tree["my_mod.scripts.solve"]
        assert isinstance(node, PDVScript)
        assert node.source_rel_path == "scripts/solve.py"

    def test_register_missing_name_sends_error(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg({"parent_path": "scripts", "relative_path": "scripts/x.py"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_script_register(msg)

        assert len(mock_comm._sent) == 1
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "script.missing_name"

    def test_register_missing_relative_path_sends_error(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg({"parent_path": "scripts", "name": "x"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_script_register(msg)

        assert len(mock_comm._sent) == 1
        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "script.missing_relative_path"

    def test_register_with_parent_path_creates_nested_script(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            {
                "parent_path": "pipeline.stage1",
                "name": "preprocess",
                "relative_path": "pipeline/stage1/preprocess.py",
            }
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_script_register(msg)

        assert isinstance(tree["pipeline.stage1.preprocess"], PDVScript)

    def test_register_emits_tree_changed_notification(self):
        tree = PDVTree()
        tree._attach_comm(
            lambda msg_type, payload: comms_mod.send_message(msg_type, payload)
        )
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            {
                "parent_path": "scripts",
                "name": "new_script",
                "relative_path": "scripts/new_script.py",
            }
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_script_register(msg)
            tree._flush_changes()

        types = [envelope["type"] for envelope in mock_comm._sent]
        assert "pdv.tree.changed" in types
        assert "pdv.script.register.response" in types
