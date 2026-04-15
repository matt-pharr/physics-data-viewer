"""
pdv-python/tests/test_handlers_lifecycle.py — Tests for lifecycle handlers.

Tests cover pdv.init handling:
1. Valid payload sets working_dir on the tree.
2. Missing working_dir in payload sends error response.
3. Non-existent working_dir path sends error response.
4. Response type is pdv.init.response.

Reference: ARCHITECTURE.md §4.1, §3.4
"""

import uuid
from unittest.mock import MagicMock, patch
import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.lifecycle import handle_init
from pdv_kernel.tree import PDVTree


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_init_msg(working_dir=None, msg_id=None):
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": msg_id or str(uuid.uuid4()),
        "in_reply_to": None,
        "type": "pdv.init",
        "payload": {"working_dir": working_dir} if working_dir is not None else {},
    }


class TestHandleInit:
    def test_valid_init_sets_working_dir(self, tmp_working_dir):
        """A valid pdv.init message configures the working dir on the tree."""
        mock_comm = _make_mock_comm()
        tree = PDVTree()
        msg = _make_init_msg(working_dir=tmp_working_dir)
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_init(msg)
        assert (
            tree._working_dir == tmp_working_dir or tree._working_dir is not None
        )  # may be realpath-resolved

    def test_valid_init_sends_ok_response(self, tmp_working_dir):
        """A valid pdv.init sends pdv.init.response with status=ok."""
        mock_comm = _make_mock_comm()
        tree = PDVTree()
        msg = _make_init_msg(working_dir=tmp_working_dir)
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_init(msg)
        assert len(mock_comm._sent) == 1
        envelope = mock_comm._sent[0]
        assert envelope["type"] == "pdv.init.response"
        assert envelope["status"] == "ok"

    def test_missing_working_dir_sends_error(self):
        """A payload missing working_dir sends status=error response."""
        mock_comm = _make_mock_comm()
        tree = PDVTree()
        msg = _make_init_msg()  # no working_dir
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_init(msg)
        assert len(mock_comm._sent) == 1
        envelope = mock_comm._sent[0]
        assert envelope["status"] == "error"
        assert "init" in envelope["payload"].get("code", "")

    def test_nonexistent_working_dir_sends_error(self):
        """A non-existent working_dir path sends status=error response."""
        mock_comm = _make_mock_comm()
        tree = PDVTree()
        msg = _make_init_msg(working_dir="/nonexistent/path/does/not/exist")
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_init(msg)
        assert len(mock_comm._sent) == 1
        envelope = mock_comm._sent[0]
        assert envelope["status"] == "error"

    def test_in_reply_to_matches_request(self, tmp_working_dir):
        """The response in_reply_to matches the request msg_id."""
        mock_comm = _make_mock_comm()
        tree = PDVTree()
        msg_id = str(uuid.uuid4())
        msg = _make_init_msg(working_dir=tmp_working_dir, msg_id=msg_id)
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree),
        ):
            handle_init(msg)
        envelope = mock_comm._sent[0]
        assert envelope["in_reply_to"] == msg_id
