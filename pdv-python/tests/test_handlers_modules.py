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
from pdv_kernel.handlers.modules import (
    handle_handler_invoke,
    handle_module_create_empty,
    handle_module_reload_libs,
    handle_module_update,
    handle_modules_setup,
)
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
        """pdv.modules.setup should add parent dirs of lib_paths to sys.path."""
        mock_comm = _make_mock_comm()
        fake_file = "/tmp/fake-module-path-for-test/n_pendulum.py"
        expected_dir = "/tmp/fake-module-path-for-test"
        msg = _make_msg(
            "pdv.modules.setup",
            {"modules": [{"lib_paths": [fake_file]}]},
        )

        try:
            with patch.object(comms_mod, "_comm", mock_comm):
                handle_modules_setup(msg)

            assert expected_dir in sys.path
            response = mock_comm._sent[0]
            assert response["type"] == "pdv.modules.setup.response"
            assert response["status"] == "ok"
        finally:
            # Clean up sys.path
            if expected_dir in sys.path:
                sys.path.remove(expected_dir)

    def test_runs_entry_point(self):
        """pdv.modules.setup should import the entry_point module."""
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.modules.setup",
            {
                "modules": [
                    {
                        "lib_paths": ["/tmp/fake/my_module.py"],
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


class TestHandleModuleReloadLibs:
    """Tests for pdv.module.reload_libs — the script:run preflight that
    importlib.reloads modules whose __file__ is under <workdir>/<alias>/lib/.
    See the #140 workflow plan §4.
    """

    def test_reloads_lib_file_under_alias(self, tree_with_comm, tmp_path):
        """A lib file edited on disk is observably reloaded in sys.modules."""
        import importlib
        import os

        from pdv_kernel.tree import PDVModule

        # Arrange: working-dir/<alias>/lib/<libname>.py
        alias = "my_mod"
        lib_dir = tmp_path / alias / "lib"
        lib_dir.mkdir(parents=True)
        lib_file = lib_dir / "helpers_reload_v1.py"
        lib_file.write_text("VALUE = 1\n")
        sys.path.insert(0, str(lib_dir))

        # Force the working dir for this test's tree.
        tree_with_comm._working_dir = str(tmp_path)

        # Install a PDVModule at the alias so the handler's is_module
        # check passes.
        tree_with_comm[alias] = PDVModule(
            module_id=alias, name="My", version="0.1.0",
        )

        try:
            import helpers_reload_v1  # noqa: PLC0415
            assert helpers_reload_v1.VALUE == 1

            # Edit the file on disk — simulates an external editor save.
            lib_file.write_text("VALUE = 42\n")

            # Call the reload handler.
            mock_comm = _make_mock_comm()
            msg = _make_msg("pdv.module.reload_libs", {"alias": alias})
            with (
                patch.object(comms_mod, "_comm", mock_comm),
                patch.object(comms_mod, "_pdv_tree", tree_with_comm),
            ):
                handle_module_reload_libs(msg)

            # Assert: the new value is observable and the response lists the reload.
            assert helpers_reload_v1.VALUE == 42
            response = mock_comm._sent[-1]
            assert response["type"] == "pdv.module.reload_libs.response"
            assert "helpers_reload_v1" in response["payload"]["reloaded"]
            assert response["payload"]["errors"] == {}
        finally:
            sys.path.remove(str(lib_dir))
            sys.modules.pop("helpers_reload_v1", None)

    def test_short_circuits_when_alias_is_not_a_module(self, tree_with_comm):
        """Handler must be cheap when the first tree-path segment is not a PDVModule.

        script:run fires the preflight for every run — reload_libs is called
        with e.g. alias="scripts" for a plain project script. The handler
        should return empty lists immediately without walking sys.modules.
        """
        mock_comm = _make_mock_comm()
        # No node at this path at all.
        msg = _make_msg("pdv.module.reload_libs", {"alias": "nonexistent"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_reload_libs(msg)

        response = mock_comm._sent[-1]
        assert response["payload"]["reloaded"] == []
        assert response["payload"]["errors"] == {}

    def test_missing_alias_sends_error_reload(self, tree_with_comm):
        """Empty alias in payload yields a structured error response."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.module.reload_libs", {})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_reload_libs(msg)

        response = mock_comm._sent[-1]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "module.missing_alias"


class TestHandleModuleCreateEmpty:
    """Tests for pdv.module.create_empty — workflow B empty-module creation."""

    def test_creates_module_with_default_subtrees(self, tree_with_comm):
        """An empty module lands with scripts/lib/plots PDVTree children."""
        from pdv_kernel.tree import PDVModule, PDVTree

        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.module.create_empty",
            {"id": "toy", "name": "Toy", "version": "0.1.0", "description": "a toy"},
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_create_empty(msg)

        mod = tree_with_comm["toy"]
        assert isinstance(mod, PDVModule)
        assert mod.module_id == "toy"
        assert mod.name == "Toy"
        assert mod.version == "0.1.0"
        assert mod.description == "a toy"
        assert isinstance(tree_with_comm["toy.scripts"], PDVTree)
        assert isinstance(tree_with_comm["toy.lib"], PDVTree)
        assert isinstance(tree_with_comm["toy.plots"], PDVTree)
        response = mock_comm._sent[-1]
        assert response["type"] == "pdv.module.create_empty.response"
        assert response["payload"]["path"] == "toy"

    def test_rejects_existing_alias(self, tree_with_comm):
        """Cannot create a module at a path already occupied in the tree."""
        tree_with_comm["toy"] = 42  # something already at that key
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.module.create_empty",
            {"id": "toy", "name": "Toy", "version": "0.1.0"},
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_create_empty(msg)

        response = mock_comm._sent[-1]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "module.alias_exists"

    def test_requires_id(self, tree_with_comm):
        """Missing id → structured error."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.module.create_empty", {"name": "Toy"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_create_empty(msg)

        response = mock_comm._sent[-1]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "module.missing_id"


class TestHandleModuleUpdate:
    """Tests for pdv.module.update — metadata editor patch handler."""

    def test_updates_mutable_fields(self, tree_with_comm):
        from pdv_kernel.tree import PDVModule

        tree_with_comm["toy"] = PDVModule(
            module_id="toy", name="Toy", version="0.1.0", description="old",
        )

        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.module.update",
            {
                "alias": "toy",
                "name": "Toy (renamed)",
                "version": "0.2.0",
                "description": "new",
            },
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_update(msg)

        mod = tree_with_comm["toy"]
        assert mod.name == "Toy (renamed)"
        assert mod.version == "0.2.0"
        assert mod.description == "new"
        response = mock_comm._sent[-1]
        assert response["type"] == "pdv.module.update.response"
        assert response["payload"]["version"] == "0.2.0"

    def test_omitted_fields_left_alone(self, tree_with_comm):
        """Only provided fields are updated; omitted fields are untouched."""
        from pdv_kernel.tree import PDVModule

        tree_with_comm["toy"] = PDVModule(
            module_id="toy", name="Toy", version="0.1.0", description="orig",
        )
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.module.update",
            {"alias": "toy", "version": "0.2.0"},
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_update(msg)
        mod = tree_with_comm["toy"]
        assert mod.name == "Toy"
        assert mod.version == "0.2.0"
        assert mod.description == "orig"

    def test_rejects_non_module_target(self, tree_with_comm):
        """Updating a path that isn't a PDVModule returns an error."""
        tree_with_comm["plain"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.module.update",
            {"alias": "plain", "name": "x"},
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_module_update(msg)
        response = mock_comm._sent[-1]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "module.not_a_module"
