"""
pdv-python/tests/test_comms.py — Unit tests for pdv.comms.

Tests cover:
1. send_message() envelope construction.
2. send_error() convenience wrapper.
3. check_version() acceptance and rejection.
4. _on_comm_message() dispatch routing (integration with mock handlers).

All IPython comm objects are mocked — no live kernel is started.

Reference: ARCHITECTURE.md §3.2, §3.5, §3.6
"""

import uuid
import pytest
from unittest.mock import MagicMock, patch
import pdv.comms as comms_mod
from pdv.errors import PDVVersionError


def _make_mock_comm():
    """Return a mock comm object that captures sent envelopes."""
    mock_comm = MagicMock()
    sent = []
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


class TestSendMessage:
    def test_envelope_structure(self):
        """send_message() produces a correctly structured PDV envelope."""
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod.send_message("pdv.test", {"k": "v"})
        envelope = mock_comm._sent[0]
        assert "pdv_version" in envelope
        assert "msg_id" in envelope
        assert "type" in envelope
        assert "status" in envelope
        assert "payload" in envelope
        assert envelope["type"] == "pdv.test"
        assert envelope["payload"] == {"k": "v"}
        assert envelope["status"] == "ok"

    def test_in_reply_to_is_set(self):
        """send_message() sets in_reply_to correctly."""
        mock_comm = _make_mock_comm()
        reply_id = str(uuid.uuid4())
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod.send_message("pdv.test", {}, in_reply_to=reply_id)
        envelope = mock_comm._sent[0]
        assert envelope["in_reply_to"] == reply_id

    def test_msg_id_is_uuid(self):
        """Each call produces a unique msg_id."""
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod.send_message("pdv.t1", {})
            comms_mod.send_message("pdv.t2", {})
        ids = [e["msg_id"] for e in mock_comm._sent]
        assert ids[0] != ids[1]
        # Each is a valid UUID
        for mid in ids:
            uuid.UUID(mid)  # raises if invalid

    def test_raises_without_comm(self):
        """send_message() raises RuntimeError if no comm is open."""
        with patch.object(comms_mod, "_comm", None):
            with pytest.raises(RuntimeError):
                comms_mod.send_message("pdv.test", {})


class TestSendError:
    def test_error_envelope(self):
        """send_error() produces an envelope with status='error'."""
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod.send_error("pdv.test.response", "some.code", "Bad thing happened")
        envelope = mock_comm._sent[0]
        assert envelope["status"] == "error"

    def test_error_payload_fields(self):
        """send_error() payload contains code and message."""
        mock_comm = _make_mock_comm()
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod.send_error(
                "pdv.test.response", "err.code", "Something went wrong"
            )
        envelope = mock_comm._sent[0]
        assert envelope["payload"]["code"] == "err.code"
        assert envelope["payload"]["message"] == "Something went wrong"


class TestCheckVersion:
    def test_matching_version_ok(self):
        """check_version() does not raise when versions match."""
        comms_mod.check_version({"pdv_version": comms_mod.PDV_PROTOCOL_VERSION})

    def test_minor_version_mismatch_ok(self):
        """A minor version difference is tolerated (no exception)."""
        major = comms_mod.PDV_PROTOCOL_VERSION.split(".")[0]
        comms_mod.check_version({"pdv_version": f"{major}.99"})

    def test_major_version_mismatch_raises(self):
        """A major version difference raises PDVVersionError."""
        # Use a major version that cannot be the current one
        wrong_major = "999"
        with pytest.raises(PDVVersionError):
            comms_mod.check_version({"pdv_version": f"{wrong_major}.0"})


class TestDispatch:
    def test_known_message_type_dispatched(self):
        """_on_comm_message() routes to the registered handler."""
        mock_comm = _make_mock_comm()
        called_with = []

        def fake_handler(msg):
            called_with.append(msg)

        # Temporarily register our fake handler
        from pdv.handlers import register, _DISPATCH

        original = _DISPATCH.get("pdv._test_dispatch")
        register("pdv._test_dispatch", fake_handler)

        msg_id = str(uuid.uuid4())
        raw_msg = {
            "content": {
                "data": {
                    "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
                    "msg_id": msg_id,
                    "in_reply_to": None,
                    "type": "pdv._test_dispatch",
                    "payload": {"x": 1},
                }
            }
        }
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod._on_comm_message(raw_msg)

        assert len(called_with) == 1
        assert called_with[0]["msg_id"] == msg_id

        # Clean up
        if original is not None:
            _DISPATCH["pdv._test_dispatch"] = original
        else:
            _DISPATCH.pop("pdv._test_dispatch", None)

    def test_unknown_message_type_returns_error(self):
        """_on_comm_message() sends a protocol.unknown_type error for unregistered types."""
        mock_comm = _make_mock_comm()
        raw_msg = {
            "content": {
                "data": {
                    "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
                    "msg_id": str(uuid.uuid4()),
                    "in_reply_to": None,
                    "type": "pdv.this_type_does_not_exist",
                    "payload": {},
                }
            }
        }
        with patch.object(comms_mod, "_comm", mock_comm):
            comms_mod._on_comm_message(raw_msg)

        # Should have sent an error response
        assert len(mock_comm._sent) == 1
        envelope = mock_comm._sent[0]
        assert envelope["status"] == "error"
        assert envelope["payload"]["code"] == "protocol.unknown_type"


class TestBootstrap:
    """Tests for pdv.bootstrap() idempotency and injection."""

    def test_bootstrap_idempotent(self, mock_ipython):
        """bootstrap() called twice does not double-inject or open a second comm."""
        import pdv.comms as comms_mod
        from pdv import bootstrap

        # Ensure clean state
        comms_mod._bootstrapped = False
        comms_mod._pdv_tree = None
        comms_mod._ip = None

        try:
            # First call
            bootstrap(mock_ipython)
            tree1 = mock_ipython.user_ns.get("pdv_tree")
            pdv1 = mock_ipython.user_ns.get("pdv")
            calls_after_first = mock_ipython.comm_manager.register_target.call_count

            # Second call — must be a no-op
            bootstrap(mock_ipython)
            tree2 = mock_ipython.user_ns.get("pdv_tree")
            pdv2 = mock_ipython.user_ns.get("pdv")
            calls_after_second = mock_ipython.comm_manager.register_target.call_count

            # Identity must be preserved — no new objects created
            assert tree1 is tree2
            assert pdv1 is pdv2
            # Comm target registered exactly once
            assert calls_after_first == 1
            assert calls_after_second == 1
        finally:
            # Restore state so other tests are not affected
            comms_mod._bootstrapped = False
            comms_mod._pdv_tree = None
            comms_mod._ip = None

    def test_bootstrap_injects_pdv_tree(self, mock_ipython):
        """bootstrap() injects pdv_tree into the user namespace."""
        import pdv.comms as comms_mod
        from pdv import bootstrap

        comms_mod._bootstrapped = False
        comms_mod._pdv_tree = None
        comms_mod._ip = None

        try:
            bootstrap(mock_ipython)
            assert "pdv_tree" in mock_ipython.user_ns
        finally:
            comms_mod._bootstrapped = False
            comms_mod._pdv_tree = None
            comms_mod._ip = None
