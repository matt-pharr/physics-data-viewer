"""
pdv-python/tests/test_handlers_modules.py — Tests for pdv.modules.setup and pdv.handler.invoke handlers.

Tests cover:
1. handle_modules_setup adds install paths to sys.path.
2. handle_modules_setup runs entry points.
3. handle_handler_invoke dispatches to a registered handler.
4. handle_handler_invoke returns error when no handler registered.

Reference: ARCHITECTURE.md §3.4
"""

import sys
import uuid
from unittest.mock import MagicMock, patch

import pytest

import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.modules import handle_handler_invoke, handle_modules_setup
from pdv_kernel.modules import clear_handlers, handle


@pytest.fixture(autouse=True)
def _clean_registry():
    """Clear handler registry before and after each test."""
    clear_handlers()
    yield
    clear_handlers()


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(msg_type, payload, msg_id=None):
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": msg_id or str(uuid.uuid4()),
        "in_reply_to": None,
        "type": msg_type,
        "payload": payload,
    }


class TestHandleModulesSetup:
    def test_adds_to_sys_path(self):
        """pdv.modules.setup should add install_path to sys.path."""
        mock_comm = _make_mock_comm()
        fake_path = "/tmp/fake-module-path-for-test"
        msg = _make_msg(
            "pdv.modules.setup",
            {"modules": [{"install_path": fake_path}]},
        )

        original_path = sys.path.copy()
        try:
            with patch.object(comms_mod, "_comm", mock_comm):
                handle_modules_setup(msg)

            assert fake_path in sys.path
            response = mock_comm._sent[0]
            assert response["type"] == "pdv.modules.setup.response"
            assert response["status"] == "ok"
        finally:
            # Clean up sys.path
            if fake_path in sys.path:
                sys.path.remove(fake_path)

    def test_runs_entry_point(self):
        """pdv.modules.setup should import the entry_point module."""
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.modules.setup",
            {
                "modules": [
                    {
                        "install_path": "/tmp/fake",
                        "entry_point": "pdv_kernel_test_fake_entry",
                    }
                ]
            },
        )

        mock_module = MagicMock()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch("importlib.import_module", return_value=mock_module) as mock_import,
        ):
            handle_modules_setup(msg)

        mock_import.assert_called_once_with("pdv_kernel_test_fake_entry")


class TestHandleHandlerInvoke:
    def test_dispatches(self, tree_with_comm):
        """pdv.handler.invoke should dispatch to the registered handler."""

        class MyType:
            pass

        called = []

        @handle(MyType)
        def on_my_type(obj, path, tree):
            called.append(path)

        tree_with_comm["test_obj"] = MyType()
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.handler.invoke", {"path": "test_obj"})

        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_handler_invoke(msg)

        assert len(called) == 1
        assert called[0] == "test_obj"
        response = mock_comm._sent[0]
        assert response["payload"]["dispatched"] is True

    def test_no_handler(self, tree_with_comm):
        """pdv.handler.invoke should return dispatched=False when no handler matches."""
        tree_with_comm["plain"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.handler.invoke", {"path": "plain"})

        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_handler_invoke(msg)

        response = mock_comm._sent[0]
        assert response["payload"]["dispatched"] is False
        assert "error" in response["payload"]
