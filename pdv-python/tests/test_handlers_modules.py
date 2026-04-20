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

import pdv.comms as comms_mod
from pdv.handlers.modules import (
    handle_handler_invoke,
    handle_module_create_empty,
    handle_module_reload_libs,
    handle_module_update,
    handle_modules_setup,
)
from pdv.modules import clear_handlers, handle


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
    """Tests for the kernel-walks-tree implementation of pdv.modules.setup.

    Payload shape: ``{"modules": [{"alias": str, "entry_point"?: str}]}``.
    The handler looks up ``tree[alias]``, walks its PDVModule subtree for
    PDVLib descendants, and inserts each unique parent directory into
    ``sys.path``. No main-side path synthesis.
    """

    def _install_module_with_libs(self, tree, tmp_path, alias, lib_rel_names):
        from pdv.tree import PDVLib, PDVModule, PDVTree

        # Point the tree at tmp_path so PDVLib.resolve_path() lines up with
        # the on-disk files we create below.
        tree._set_working_dir(str(tmp_path))

        module = PDVModule(module_id=alias, name=alias, version="0.1.0")
        module._working_dir = str(tmp_path)
        lib_container = PDVTree()
        lib_container._working_dir = str(tmp_path)
        for rel in lib_rel_names:
            abs_path = tmp_path / rel
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            abs_path.write_text("# test lib\n")
            lib_node = PDVLib(relative_path=rel, module_id=alias)
            key = abs_path.stem
            dict.__setitem__(lib_container, key, lib_node)
        dict.__setitem__(module, "lib", lib_container)
        dict.__setitem__(tree, alias, module)
        return module

    def test_walks_module_for_libs(self, tree_with_comm, tmp_path):
        """Walker adds the parent dir of every PDVLib descendant to sys.path."""
        module = self._install_module_with_libs(
            tree_with_comm,
            tmp_path,
            "toy",
            ["tree/toy/lib/helpers.py", "tree/toy/extras/more.py"],
        )
        assert module is not None

        expected_dirs = [
            str(tmp_path / "tree" / "toy" / "lib"),
            str(tmp_path / "tree" / "toy" / "extras"),
        ]

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.modules.setup", {"modules": [{"alias": "toy"}]})

        try:
            with (
                patch.object(comms_mod, "_comm", mock_comm),
                patch.object(comms_mod, "_pdv_tree", tree_with_comm),
            ):
                handle_modules_setup(msg)

            for expected in expected_dirs:
                assert expected in sys.path, (
                    f"{expected} missing from sys.path after setup"
                )
            response = mock_comm._sent[-1]
            assert response["type"] == "pdv.modules.setup.response"
        finally:
            for expected in expected_dirs:
                while expected in sys.path:
                    sys.path.remove(expected)

    def test_deduplicates_sibling_libs(self, tree_with_comm, tmp_path):
        """Two PDVLib nodes in the same directory produce one sys.path entry."""
        self._install_module_with_libs(
            tree_with_comm,
            tmp_path,
            "toy",
            ["tree/toy/lib/a.py", "tree/toy/lib/b.py"],
        )
        expected_dir = str(tmp_path / "tree" / "toy" / "lib")

        # Clear any prior entries so the count assertion is meaningful.
        while expected_dir in sys.path:
            sys.path.remove(expected_dir)

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.modules.setup", {"modules": [{"alias": "toy"}]})

        try:
            with (
                patch.object(comms_mod, "_comm", mock_comm),
                patch.object(comms_mod, "_pdv_tree", tree_with_comm),
            ):
                handle_modules_setup(msg)

            assert sys.path.count(expected_dir) == 1
        finally:
            while expected_dir in sys.path:
                sys.path.remove(expected_dir)

    def test_missing_module_warns_and_continues(self, tree_with_comm, tmp_path):
        """Unknown aliases warn but do not abort the loop — other modules still set up."""
        self._install_module_with_libs(
            tree_with_comm,
            tmp_path,
            "present",
            ["tree/present/lib/p.py"],
        )
        expected_dir = str(tmp_path / "tree" / "present" / "lib")

        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.modules.setup",
            {"modules": [{"alias": "ghost"}, {"alias": "present"}]},
        )

        try:
            with (
                patch.object(comms_mod, "_comm", mock_comm),
                patch.object(comms_mod, "_pdv_tree", tree_with_comm),
                pytest.warns(UserWarning, match="no PDVModule"),
            ):
                handle_modules_setup(msg)

            assert expected_dir in sys.path
        finally:
            while expected_dir in sys.path:
                sys.path.remove(expected_dir)

    def test_empty_module_is_noop_but_not_error(self, tree_with_comm):
        """An empty PDVModule (create_empty just ran) triggers no sys.path edits and no warnings."""
        from pdv.tree import PDVModule, PDVTree

        module = PDVModule(module_id="fresh", name="fresh", version="0.1.0")
        for child in ("scripts", "lib", "plots"):
            dict.__setitem__(module, child, PDVTree())
        dict.__setitem__(tree_with_comm, "fresh", module)

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.modules.setup", {"modules": [{"alias": "fresh"}]})

        sys_path_before = list(sys.path)
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_modules_setup(msg)
        # No new entries added for an empty module.
        assert sys.path == sys_path_before
        assert mock_comm._sent[-1]["type"] == "pdv.modules.setup.response"

    def test_runs_entry_point(self, tree_with_comm, tmp_path):
        """pdv.modules.setup should import the entry_point module."""
        self._install_module_with_libs(
            tree_with_comm, tmp_path, "ep_mod", []
        )

        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.modules.setup",
            {
                "modules": [
                    {
                        "alias": "ep_mod",
                        "entry_point": "pdv_test_fake_entry",
                    }
                ]
            },
        )

        mock_module = MagicMock()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
            patch("importlib.import_module", return_value=mock_module) as mock_import,
        ):
            handle_modules_setup(msg)

        mock_import.assert_called_once_with("pdv_test_fake_entry")

    def test_create_empty_then_register_lib_allows_sibling_import(
        self, tree_with_comm, tmp_path
    ):
        """End-to-end kernel-side audit repro.

        Create an empty module, register a PDVLib with real on-disk contents,
        register a sibling PDVScript, run setup, and assert the script can
        import from the sibling lib.
        """
        from pdv.tree import PDVLib, PDVModule, PDVScript, PDVTree

        alias = "ddho"
        scripts_dir = tmp_path / "tree" / alias / "scripts"
        lib_dir = tmp_path / "tree" / alias / "lib"
        scripts_dir.mkdir(parents=True)
        lib_dir.mkdir(parents=True)

        lib_file = lib_dir / "ddho_lib.py"
        lib_file.write_text("K = 1.25\n")
        script_file = scripts_dir / "run_ddho.py"
        script_file.write_text(
            "from ddho_lib import K\n"
            "def run(pdv_tree):\n"
            "    return {'k': K}\n"
        )

        tree_with_comm._set_working_dir(str(tmp_path))
        module = PDVModule(module_id=alias, name=alias, version="0.1.0")
        module._working_dir = str(tmp_path)
        scripts_container = PDVTree()
        scripts_container._working_dir = str(tmp_path)
        libs_container = PDVTree()
        libs_container._working_dir = str(tmp_path)
        dict.__setitem__(
            libs_container,
            "ddho_lib",
            PDVLib(
                relative_path=f"tree/{alias}/lib/ddho_lib.py",
                module_id=alias,
            ),
        )
        dict.__setitem__(
            scripts_container,
            "run_ddho",
            PDVScript(
                relative_path=f"tree/{alias}/scripts/run_ddho.py",
                language="python",
                module_id=alias,
            ),
        )
        dict.__setitem__(module, "lib", libs_container)
        dict.__setitem__(module, "scripts", scripts_container)
        dict.__setitem__(tree_with_comm, alias, module)

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.modules.setup", {"modules": [{"alias": alias}]})

        try:
            with (
                patch.object(comms_mod, "_comm", mock_comm),
                patch.object(comms_mod, "_pdv_tree", tree_with_comm),
            ):
                handle_modules_setup(msg)

            script_node = tree_with_comm[f"{alias}.scripts.run_ddho"]
            result = script_node.run(tree_with_comm)
            assert result == {"k": 1.25}
        finally:
            lib_parent = str(lib_dir)
            while lib_parent in sys.path:
                sys.path.remove(lib_parent)
            sys.modules.pop("ddho_lib", None)


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

        from pdv.tree import PDVModule

        # Arrange: working-dir/tree/<alias>/lib/<libname>.py — the
        # ``tree/`` prefix is the canonical working-dir subdir for
        # file-backed nodes after the Option-A layout fix.
        alias = "my_mod"
        lib_dir = tmp_path / "tree" / alias / "lib"
        lib_dir.mkdir(parents=True)
        lib_file = lib_dir / "helpers_reload_v1.py"
        lib_file.write_text("VALUE = 1\n")
        sys.path.insert(0, str(lib_dir))

        # Force the working dir for this test's tree.
        tree_with_comm._working_dir = str(tmp_path)

        # Install a PDVModule at the alias so the handler's is_module
        # check passes.
        tree_with_comm[alias] = PDVModule(
            module_id=alias,
            name="My",
            version="0.1.0",
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
        from pdv.tree import PDVModule, PDVTree

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
        from pdv.tree import PDVModule

        tree_with_comm["toy"] = PDVModule(
            module_id="toy",
            name="Toy",
            version="0.1.0",
            description="old",
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
        from pdv.tree import PDVModule

        tree_with_comm["toy"] = PDVModule(
            module_id="toy",
            name="Toy",
            version="0.1.0",
            description="orig",
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
