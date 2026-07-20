"""
pdv-python/tests/test_introspection_handlers.py — Tests for the
introspection and path-resolution handlers used by the MCP server.

Covers ``pdv.help`` (symbol introspection) and ``pdv.tree.resolve_path``
(bidirectional tree-path <-> file-path translation).
"""

import os
import sys
import uuid
from unittest.mock import MagicMock, patch

import pdv.comms as comms_mod
from pdv.handlers.introspection import handle_help, handle_resolve_path
from pdv.tree import PDVScript, PDVTree


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


class TestHandleHelp:
    def test_resolves_pdv_module_symbol(self):
        """pdv.help resolves a pdv-package symbol and returns metadata."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": "pdv.PDVTree"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        response = mock_comm._sent[0]
        assert response["type"] == "pdv.help.response"
        assert response["status"] == "ok"
        payload = response["payload"]
        assert payload["symbol"] == "pdv.PDVTree"
        assert payload["kind"] == "class"
        assert payload["doc"] is not None
        assert "live project data tree" in payload["doc"]
        # Source is omitted unless include_source is requested.
        assert payload["source"] is None

    def test_resolves_module_itself(self):
        """pdv.help resolves a bare module symbol."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": "pdv"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        payload = mock_comm._sent[0]["payload"]
        assert payload["kind"] == "module"
        assert payload["doc"] is not None

    def test_resolves_function_signature(self):
        """pdv.help returns a signature for an introspectable function."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": "pdv.add_file"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        payload = mock_comm._sent[0]["payload"]
        assert payload["kind"] == "function"
        assert payload["signature"] is not None
        assert "source_path" in payload["signature"]

    def test_resolves_user_namespace_symbol(self):
        """pdv.help resolves a variable defined in the kernel user namespace."""
        def my_user_fn(alpha, beta=3):
            """A user-defined function."""
            return alpha + beta

        ip = MagicMock()
        ip.user_ns = {"my_user_fn": my_user_fn}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": "my_user_fn"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        payload = mock_comm._sent[0]["payload"]
        assert payload["symbol"] == "my_user_fn"
        assert payload["kind"] == "function"
        assert payload["signature"] == "(alpha, beta=3)"
        assert payload["doc"] == "A user-defined function."

    def test_include_source_returns_source(self):
        """pdv.help with include_source=True populates the source field."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.help", {"symbol": "pdv.PDVScript", "include_source": True}
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        # Select the help response by type rather than trusting _sent[0]:
        # a debounced tree-change push from a prior test can land in the
        # patched comm mid-test on slow runners (observed once in CI) and
        # would otherwise shadow the response.
        payload = next(
            m["payload"]
            for m in mock_comm._sent
            if m["type"] == "pdv.help.response"
        )
        assert payload["source"] is not None
        assert "class PDVScript" in payload["source"]

    def test_unresolvable_symbol_sends_error(self):
        """pdv.help on a symbol that cannot be resolved sends an error."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": "nonexistent_module_xyz.foo"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "introspection.symbol_not_found"

    def test_resolves_bare_pdv_class_name(self):
        """pdv.help resolves a bare class name like 'PDVScript' by falling
        back to looking up attributes of the loaded `pdv` module — the
        same way `from pdv import PDVScript` works at the kernel."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": "PDVScript"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        response = mock_comm._sent[0]
        assert response["type"] == "pdv.help.response"
        assert response["status"] == "ok"
        payload = response["payload"]
        assert payload["symbol"] == "PDVScript"
        assert payload["kind"] == "class"

    def test_does_not_implicitly_import_modules(self):
        """pdv.help refuses to introspect a symbol whose head module is not
        already loaded in sys.modules, instead of triggering an import.
        An implicit import would execute the module's __init__.py and is
        a side channel for attacker-influenced lookup strings.
        """
        fake_module = "pdv_test_unloaded_module_xyz"
        sys.modules.pop(fake_module, None)
        assert fake_module not in sys.modules
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {"symbol": fake_module})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "introspection.symbol_not_found"
        assert "not loaded" in response["payload"]["message"]
        # The lookup did NOT auto-import the module.
        assert fake_module not in sys.modules

    def test_missing_symbol_sends_error(self):
        """pdv.help with no symbol sends a missing-symbol error."""
        ip = MagicMock()
        ip.user_ns = {}
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.help", {})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_ip", ip),
        ):
            handle_help(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "introspection.missing_symbol"


class TestHandleResolvePath:
    def _make_script_node(self, working_dir, node_uuid, filename):
        """Create a PDVScript with a backing file on disk."""
        tree_dir = os.path.join(working_dir, "tree", node_uuid)
        os.makedirs(tree_dir, exist_ok=True)
        file_path = os.path.join(tree_dir, filename)
        with open(file_path, "w") as fh:
            fh.write("def run(pdv_tree: dict):\n    return {}\n")
        return PDVScript(uuid=node_uuid, filename=filename), file_path

    def test_forward_file_backed_node_returns_file_path(self, tree_with_comm):
        """Forward: a tree path of a file-backed node -> its file path."""
        working_dir = tree_with_comm._working_dir
        script, file_path = self._make_script_node(
            working_dir, "resolvuuid001", "fit_model.py"
        )
        tree_with_comm["scripts.fit"] = script

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.resolve_path", {"path": "scripts.fit"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        response = mock_comm._sent[0]
        assert response["type"] == "pdv.tree.resolve_path.response"
        assert response["status"] == "ok"
        payload = response["payload"]
        assert payload["input"] == "scripts.fit"
        assert payload["tree_paths"] == ["scripts.fit"]
        assert payload["file_path"] == file_path

    def test_forward_non_file_node_returns_null_file_path(self, tree_with_comm):
        """Forward: a non-file-backed node returns file_path=None."""
        tree_with_comm["data.value"] = 42

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.resolve_path", {"path": "data.value"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        payload = mock_comm._sent[0]["payload"]
        assert payload["tree_paths"] == ["data.value"]
        assert payload["file_path"] is None

    def test_forward_missing_path_sends_error(self, tree_with_comm):
        """Forward: a non-existent tree path sends an error."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.resolve_path", {"path": "no.such.path"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "tree.path_not_found"

    def test_reverse_file_path_returns_tree_path(self, tree_with_comm):
        """Reverse: an absolute file path -> the owning tree path."""
        working_dir = tree_with_comm._working_dir
        script, file_path = self._make_script_node(
            working_dir, "resolvuuid002", "analysis.py"
        )
        tree_with_comm["scripts.analysis"] = script

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.resolve_path", {"path": file_path})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        payload = response["payload"]
        assert payload["tree_paths"] == ["scripts.analysis"]
        assert payload["file_path"] == os.path.realpath(file_path)

    def test_reverse_shared_uuid_returns_all_tree_paths(self, tree_with_comm):
        """Reverse: copies sharing a UUID all appear in tree_paths."""
        working_dir = tree_with_comm._working_dir
        script, file_path = self._make_script_node(
            working_dir, "resolvuuid003", "shared.py"
        )
        # Two tree nodes pointing at the same UUID-backed file.
        tree_with_comm["a.first"] = script
        tree_with_comm["b.second"] = PDVScript(
            uuid="resolvuuid003", filename="shared.py"
        )

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.resolve_path", {"path": file_path})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        payload = mock_comm._sent[0]["payload"]
        assert set(payload["tree_paths"]) == {"a.first", "b.second"}

    def test_reverse_unknown_file_returns_empty_tree_paths(self, tree_with_comm):
        """Reverse: a file path with no owning node returns an empty list."""
        mock_comm = _make_mock_comm()
        msg = _make_msg(
            "pdv.tree.resolve_path",
            {"path": "/nonexistent/tree/deadbeef0000/foo.py"},
        )
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "ok"
        assert response["payload"]["tree_paths"] == []

    def test_missing_path_sends_error(self, tree_with_comm):
        """An empty path sends a missing-path error."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.tree.resolve_path", {})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_resolve_path(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "introspection.missing_path"


def test_query_socket_whitelist_includes_introspection_types():
    """The introspection handlers are read-only and the MCP server routes
    them through the read-only query socket. Guard against the QueryServer
    whitelist desyncing from the registered handler message types.
    """
    from pdv.query_server import _ALLOWED_TYPES

    assert "pdv.help" in _ALLOWED_TYPES
    assert "pdv.tree.resolve_path" in _ALLOWED_TYPES
