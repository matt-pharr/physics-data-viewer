"""
pdv-python/tests/test_integration_bootstrap.py — Integration-style bootstrap/ready tests.
"""

from unittest.mock import MagicMock
from types import SimpleNamespace

import pdv.comms as comms_mod
from pdv import bootstrap


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _reset_bootstrap_state():
    comms_mod._bootstrapped = False
    comms_mod._pdv_tree = None
    comms_mod._ip = None
    comms_mod._comm = None


class TestBootstrapReadyFlow:
    def test_bootstrap_sends_pdv_ready_push(self, mock_ipython):
        _reset_bootstrap_state()
        try:
            bootstrap(mock_ipython)
            callback = mock_ipython.comm_manager.register_target.call_args[0][1]
            mock_comm = _make_mock_comm()

            callback(mock_comm, {"content": {"data": {}}})

            assert len(mock_comm._sent) == 1
            ready = mock_comm._sent[0]
            assert ready["type"] == "pdv.ready"
            assert ready["status"] == "ok"
            assert ready["in_reply_to"] is None
        finally:
            _reset_bootstrap_state()

    def test_bootstrap_pdv_ready_contains_protocol_envelope_fields(self, mock_ipython):
        _reset_bootstrap_state()
        try:
            bootstrap(mock_ipython)
            callback = mock_ipython.comm_manager.register_target.call_args[0][1]
            mock_comm = _make_mock_comm()

            callback(mock_comm, {"content": {"data": {}}})

            ready = mock_comm._sent[0]
            assert ready["pdv_version"] == comms_mod.PDV_PROTOCOL_VERSION
            assert isinstance(ready["msg_id"], str) and ready["msg_id"]
            assert ready["payload"] == {}
        finally:
            _reset_bootstrap_state()

    def test_bootstrap_twice_does_not_send_second_ready(self, mock_ipython):
        _reset_bootstrap_state()
        try:
            bootstrap(mock_ipython)
            bootstrap(mock_ipython)

            assert mock_ipython.comm_manager.register_target.call_count == 1
            callback = mock_ipython.comm_manager.register_target.call_args[0][1]
            mock_comm = _make_mock_comm()
            callback(mock_comm, {"content": {"data": {}}})

            ready_messages = [m for m in mock_comm._sent if m["type"] == "pdv.ready"]
            assert len(ready_messages) == 1
        finally:
            _reset_bootstrap_state()

    def test_bootstrap_falls_back_to_kernel_comm_manager(self):
        _reset_bootstrap_state()
        try:
            kernel_comm_manager = MagicMock()
            shell = SimpleNamespace(
                user_ns={},
                kernel=SimpleNamespace(comm_manager=kernel_comm_manager),
            )
            bootstrap(shell)
            kernel_comm_manager.register_target.assert_called_once_with(
                comms_mod.PDV_COMM_TARGET,
                comms_mod._on_comm_open,
            )
        finally:
            _reset_bootstrap_state()

    def test_bootstrap_prewarms_jedi_via_ip_complete(self, mock_ipython):
        _reset_bootstrap_state()
        try:
            bootstrap(mock_ipython)
            mock_ipython.complete.assert_called_once_with("pdv_tree.")
        finally:
            _reset_bootstrap_state()

    def test_bootstrap_succeeds_when_jedi_prewarm_raises(self, mock_ipython):
        _reset_bootstrap_state()
        try:
            mock_ipython.complete.side_effect = RuntimeError("jedi exploded")
            bootstrap(mock_ipython)
            assert comms_mod._bootstrapped is True
            # pdv.ready still wired up: opening a comm should send the ready push.
            callback = mock_ipython.comm_manager.register_target.call_args[0][1]
            mock_comm = _make_mock_comm()
            callback(mock_comm, {"content": {"data": {}}})
            assert any(m["type"] == "pdv.ready" for m in mock_comm._sent)
        finally:
            _reset_bootstrap_state()
