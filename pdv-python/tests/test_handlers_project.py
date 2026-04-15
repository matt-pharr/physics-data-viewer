"""
pdv-python/tests/test_handlers_project.py — Tests for project save/load handlers.

Tests cover:
1. pdv.project.load: reads tree-index.json, builds tree.
2. pdv.project.load: nonexistent save_dir sends error.
3. pdv.project.load: pushes pdv.project.loaded notification.
4. pdv.project.save: writes tree-index.json, writes data files.
5. pdv.project.save: response includes node_count and checksum.
6. Two-pass loading: containers created before leaves regardless of order.
7. Metadata round-trips for module, gui, namelist, lib nodes.

Reference: ARCHITECTURE.md §4.2, §8
"""

import json
import os
import uuid
import pytest
from unittest.mock import MagicMock, patch
import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.project import handle_project_load, handle_project_save
from pdv_kernel.tree import (
    PDVTree,
    PDVScript,
    PDVModule,
    PDVGui,
    PDVNamelist,
    PDVLib,
)


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


def _write_tree_index(save_dir, nodes):
    with open(os.path.join(save_dir, "tree-index.json"), "w") as f:
        json.dump(nodes, f)


class TestHandleProjectLoad:
    def test_loads_tree_from_index(self, tree_with_comm, tmp_save_dir):
        """handle_project_load() reads tree-index.json and builds the tree skeleton."""
        nodes = [
            {
                "path": "data",
                "type": "folder",
                "storage": {"backend": "none", "format": "none"},
                "metadata": {"preview": "folder"},
            },
            {
                "path": "data.x",
                "type": "scalar",
                "storage": {"backend": "inline", "format": "inline", "value": 42},
                "metadata": {"preview": "42"},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        # Inline value should be accessible
        assert tree_with_comm["data.x"] == 42

    def test_file_backed_nodes_eagerly_loaded(self, tree_with_comm, tmp_save_dir):
        """File-backed nodes from tree-index.json are eagerly deserialized into the tree."""
        numpy = pytest.importorskip("numpy")
        arr = numpy.array([1.0, 2.0, 3.0])
        tree_dir = os.path.join(tree_with_comm._working_dir, "tree")
        os.makedirs(tree_dir, exist_ok=True)
        numpy.save(os.path.join(tree_dir, "arr.npy"), arr)
        nodes = [
            {
                "path": "arr",
                "type": "ndarray",
                "storage": {
                    "backend": "local_file",
                    "relative_path": "tree/arr.npy",
                    "format": "npy",
                },
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        assert numpy.array_equal(dict.__getitem__(tree_with_comm, "arr"), arr)

    def test_sends_project_loaded_push(self, tree_with_comm, tmp_save_dir):
        """After loading, pdv.project.loaded push notification is sent."""
        _write_tree_index(tmp_save_dir, [])
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        types_sent = [e["type"] for e in mock_comm._sent]
        assert "pdv.project.load.response" in types_sent
        assert "pdv.project.loaded" in types_sent

    def test_script_nodes_restore_as_pdvscript(self, tree_with_comm, tmp_save_dir):
        """Script descriptors are restored as PDVScript instances, not plain text."""
        # Create file in working dir (TypeScript copies before load)
        working_dir = tree_with_comm._working_dir
        script_rel = os.path.join("tree", "scripts", "demo.py")
        script_file = os.path.join(working_dir, script_rel)
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, "w", encoding="utf-8") as fh:
            fh.write("def run(pdv_tree: dict):\n    return {}\n")

        nodes = [
            {
                "path": "scripts",
                "type": "folder",
                "storage": {"backend": "none", "format": "none"},
                "metadata": {"preview": "folder"},
            },
            {
                "path": "scripts.demo",
                "type": "script",
                "storage": {
                    "backend": "local_file",
                    "relative_path": script_rel,
                    "format": "py_script",
                },
                "metadata": {"language": "python", "doc": None, "preview": "script"},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        assert isinstance(tree_with_comm["scripts.demo"], PDVScript)

    def test_nonexistent_save_dir_sends_error(self, tree_with_comm):
        """A non-existent save_dir sends status=error response."""
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": "/no/such/directory"})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        assert len(mock_comm._sent) == 1
        envelope = mock_comm._sent[0]
        assert envelope["status"] == "error"


class TestHandleProjectSave:
    def test_writes_tree_index(self, tree_with_comm, tmp_save_dir):
        """handle_project_save() writes tree-index.json to the save directory."""
        tree_with_comm["x"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)
        index_path = os.path.join(tmp_save_dir, "tree-index.json")
        assert os.path.exists(index_path)
        with open(index_path) as f:
            nodes = json.load(f)
        assert isinstance(nodes, list)

    def test_writes_data_files(self, tree_with_comm, tmp_save_dir):
        """Data files are written for each serializable node."""
        numpy = pytest.importorskip("numpy")
        tree_with_comm["arr"] = numpy.array([1.0, 2.0, 3.0])
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)
        # The .npy file should exist somewhere under tmp_save_dir/tree/
        npy_files = []
        for root, _, files in os.walk(tmp_save_dir):
            for f in files:
                if f.endswith(".npy"):
                    npy_files.append(f)
        assert len(npy_files) > 0

    def test_response_has_node_count(self, tree_with_comm, tmp_save_dir):
        """Response payload includes node_count."""
        tree_with_comm["a"] = 1
        tree_with_comm["b"] = 2
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)
        response = mock_comm._sent[-1]
        assert response["type"] == "pdv.project.save.response"
        assert response["status"] == "ok"
        assert "node_count" in response["payload"]
        assert response["payload"]["node_count"] >= 2

    def test_response_has_checksum(self, tree_with_comm, tmp_save_dir):
        """Response payload includes checksum of tree-index.json."""
        tree_with_comm["c"] = 3
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)
        response = mock_comm._sent[-1]
        assert "checksum" in response["payload"]
        assert len(response["payload"]["checksum"]) == 32  # XXH3-128 hex

    def test_save_load_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Save then load produces an isomorphic tree."""
        tree_with_comm["score"] = 99
        mock_comm = _make_mock_comm()
        msg_save = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg_save)

        # Now load into a fresh tree
        fresh_tree = PDVTree()
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm2),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(msg_load)

        assert fresh_tree["score"] == 99

    def test_save_produces_metadata_subdicts(self, tree_with_comm, tmp_save_dir):
        """After saving, tree-index.json nodes have metadata sub-dicts."""
        tree_with_comm["x"] = 42
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)
        with open(os.path.join(tmp_save_dir, "tree-index.json")) as f:
            nodes = json.load(f)
        for node in nodes:
            assert "metadata" in node, f"Missing metadata for {node['path']}"
            assert "preview" in node["metadata"]

    def test_save_response_includes_module_owned_files(
        self, tree_with_comm, tmp_save_dir
    ):
        """Module-owned PDVFile nodes surface in the save response so the main
        process can mirror them into <saveDir>/modules/<id>/<source_rel_path>."""
        working_dir = tree_with_comm._working_dir
        # Place a script file and a lib file under the working-dir alias.
        scripts_dir = os.path.join(working_dir, "my_mod", "scripts")
        lib_dir = os.path.join(working_dir, "my_mod", "lib")
        os.makedirs(scripts_dir, exist_ok=True)
        os.makedirs(lib_dir, exist_ok=True)
        script_path = os.path.join(scripts_dir, "run.py")
        with open(script_path, "w") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")
        lib_path = os.path.join(lib_dir, "helpers.py")
        with open(lib_path, "w") as f:
            f.write("VALUE = 1\n")

        # Build a PDVModule containing both.
        module = PDVModule(module_id="my_mod", name="My", version="0.1.0")
        module["scripts"] = PDVTree()
        module["scripts.run"] = PDVScript(
            relative_path=script_path,
            module_id="my_mod",
            source_rel_path="scripts/run.py",
        )
        module["lib"] = PDVTree()
        module["lib.helpers"] = PDVLib(
            relative_path=lib_path,
            module_id="my_mod",
            source_rel_path="lib/helpers.py",
        )
        tree_with_comm["my_mod"] = module

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)

        # Find the save response among the sent messages.
        response = next(
            m for m in mock_comm._sent if m.get("type") == "pdv.project.save.response"
        )
        owned = response["payload"].get("module_owned_files", [])
        # Should contain entries for both the script and the lib.
        by_rel = {entry["source_rel_path"]: entry for entry in owned}
        assert "scripts/run.py" in by_rel
        assert "lib/helpers.py" in by_rel
        assert by_rel["scripts/run.py"]["module_id"] == "my_mod"
        assert by_rel["lib/helpers.py"]["module_id"] == "my_mod"
        # workdir_path must be absolute so the main process can open it directly.
        assert os.path.isabs(by_rel["scripts/run.py"]["workdir_path"])
        assert os.path.isabs(by_rel["lib/helpers.py"]["workdir_path"])

    def test_save_response_includes_module_manifests(
        self, tree_with_comm, tmp_save_dir
    ):
        """Each PDVModule surfaces a full manifest bundle with module-root-relative descriptors."""
        working_dir = tree_with_comm._working_dir
        scripts_dir = os.path.join(working_dir, "toy", "scripts")
        lib_dir = os.path.join(working_dir, "toy", "lib")
        os.makedirs(scripts_dir, exist_ok=True)
        os.makedirs(lib_dir, exist_ok=True)
        script_path = os.path.join(scripts_dir, "hello.py")
        with open(script_path, "w") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")
        lib_path = os.path.join(lib_dir, "helpers.py")
        with open(lib_path, "w") as f:
            f.write("VALUE = 1\n")

        from pdv_kernel.tree import PDVLib, PDVScript, PDVTree

        module = PDVModule(
            module_id="toy",
            name="Toy",
            version="0.1.0",
            description="a toy",
            language="python",
        )
        module["scripts"] = PDVTree()
        module["scripts.hello"] = PDVScript(
            relative_path=script_path,
            module_id="toy",
            source_rel_path="scripts/hello.py",
        )
        module["lib"] = PDVTree()
        module["lib.helpers"] = PDVLib(
            relative_path=lib_path,
            module_id="toy",
            source_rel_path="lib/helpers.py",
        )
        module["plots"] = PDVTree()
        tree_with_comm["toy"] = module

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)

        response = next(
            m for m in mock_comm._sent if m.get("type") == "pdv.project.save.response"
        )
        manifests = response["payload"].get("module_manifests", [])
        assert len(manifests) == 1
        bundle = manifests[0]
        assert bundle["module_id"] == "toy"
        assert bundle["name"] == "Toy"
        assert bundle["version"] == "0.1.0"
        assert bundle["description"] == "a toy"
        assert bundle["language"] == "python"

        by_path = {e["path"]: e for e in bundle["entries"]}
        # Three container entries (scripts, lib, plots) and two leaves
        # — all rooted at the module, not prefixed with "toy.".
        assert "scripts" in by_path
        assert "lib" in by_path
        assert "plots" in by_path
        assert by_path["scripts"]["type"] == "folder"
        assert "scripts.hello" in by_path
        assert by_path["scripts.hello"]["type"] == "script"
        assert (
            by_path["scripts.hello"]["storage"]["relative_path"] == "scripts/hello.py"
        )
        assert by_path["scripts.hello"]["parent_path"] == "scripts"
        assert "lib.helpers" in by_path
        assert by_path["lib.helpers"]["storage"]["relative_path"] == "lib/helpers.py"
        assert by_path["lib.helpers"]["type"] == "lib"

    def test_save_response_has_empty_manifests_when_no_modules(
        self, tree_with_comm, tmp_save_dir
    ):
        """Projects without PDVModule nodes emit an empty module_manifests list."""
        tree_with_comm["score"] = 99
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)
        response = next(
            m for m in mock_comm._sent if m.get("type") == "pdv.project.save.response"
        )
        assert response["payload"].get("module_manifests", []) == []

    def test_save_response_excludes_non_module_files(
        self, tree_with_comm, tmp_save_dir
    ):
        """Scripts outside any PDVModule subtree do not appear in module_owned_files."""
        working_dir = tree_with_comm._working_dir
        scripts_dir = os.path.join(working_dir, "project_scripts")
        os.makedirs(scripts_dir, exist_ok=True)
        script_path = os.path.join(scripts_dir, "plain.py")
        with open(script_path, "w") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")
        # Plain PDVScript with no module context and no source_rel_path.
        tree_with_comm["scripts"] = PDVTree()
        tree_with_comm["scripts.plain"] = PDVScript(relative_path=script_path)

        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg)

        response = next(
            m for m in mock_comm._sent if m.get("type") == "pdv.project.save.response"
        )
        assert response["payload"].get("module_owned_files", []) == []


class TestTwoPassLoading:
    """Tests for two-pass load ordering and metadata preservation."""

    def test_child_before_parent_gui(self, tree_with_comm, tmp_save_dir):
        """GUI node listed before its module parent still loads correctly."""
        working_dir = tree_with_comm._working_dir
        gui_rel = os.path.join("tree", "mymod", "gui.gui.json")
        gui_file = os.path.join(working_dir, gui_rel)
        os.makedirs(os.path.dirname(gui_file), exist_ok=True)
        with open(gui_file, "w") as f:
            f.write("{}")

        # Intentionally put gui node BEFORE its module parent
        nodes = [
            {
                "path": "mymod.gui",
                "type": "gui",
                "storage": {
                    "backend": "local_file",
                    "relative_path": gui_rel,
                    "format": "gui_json",
                },
                "metadata": {"module_id": "test_mod", "preview": "GUI"},
            },
            {
                "path": "mymod",
                "type": "module",
                "has_children": True,
                "storage": {
                    "backend": "inline",
                    "format": "module_meta",
                    "value": {
                        "module_id": "test_mod",
                        "name": "Test",
                        "version": "1.0",
                    },
                },
                "metadata": {
                    "module_id": "test_mod",
                    "name": "Test",
                    "version": "1.0",
                    "preview": "Test v1.0",
                },
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        assert isinstance(tree_with_comm["mymod"], PDVModule)
        assert isinstance(tree_with_comm["mymod.gui"], PDVGui)
        # GUI should be attached to the module
        assert tree_with_comm["mymod"].gui is tree_with_comm["mymod.gui"]

    def test_module_metadata_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Module metadata (module_id, name, version) survives save→load."""
        mod = PDVModule(module_id="roundtrip_mod", name="Roundtrip", version="2.5.0")
        tree_with_comm["mod"] = mod
        mock_comm = _make_mock_comm()
        msg_save = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg_save)

        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(tree_with_comm._working_dir)
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm2),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(msg_load)
        loaded_mod = fresh_tree["mod"]
        assert isinstance(loaded_mod, PDVModule)
        assert loaded_mod.module_id == "roundtrip_mod"
        assert loaded_mod.name == "Roundtrip"
        assert loaded_mod.version == "2.5.0"

    def test_gui_module_id_roundtrip(self, tree_with_comm, tmp_save_dir):
        """GUI module_id survives save→load."""
        from pdv_kernel.tree import PDVModule, PDVGui

        mod = PDVModule(module_id="gui_mod", name="GuiMod", version="1.0")
        tree_with_comm["gmod"] = mod
        gui_rel = os.path.join("tree", "gmod", "gui.gui.json")
        gui_file = os.path.join(tree_with_comm._working_dir, gui_rel)
        os.makedirs(os.path.dirname(gui_file), exist_ok=True)
        with open(gui_file, "w") as f:
            f.write('{"layout": {}}')
        gui = PDVGui(relative_path=gui_file, module_id="gui_mod")
        dict.__setitem__(mod, "gui", gui)
        mod.gui = gui

        mock_comm = _make_mock_comm()
        msg_save = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg_save)

        # Verify metadata in tree-index.json
        with open(os.path.join(tmp_save_dir, "tree-index.json")) as f:
            nodes = json.load(f)
        gui_nodes = [n for n in nodes if n["type"] == "gui"]
        assert len(gui_nodes) == 1
        assert gui_nodes[0]["metadata"]["module_id"] == "gui_mod"

    def test_namelist_format_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Namelist format and module_id survive save→load."""
        nml_rel = os.path.join("tree", "solver.nml")
        nml_file = os.path.join(tree_with_comm._working_dir, nml_rel)
        os.makedirs(os.path.dirname(nml_file), exist_ok=True)
        with open(nml_file, "w") as f:
            f.write("&solver /\n")
        nml = PDVNamelist(relative_path=nml_file, format="fortran", module_id="nml_mod")
        tree_with_comm["solver"] = nml

        mock_comm = _make_mock_comm()
        msg_save = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg_save)

        fresh_tree = PDVTree()
        fresh_tree._set_working_dir(tree_with_comm._working_dir)
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm2),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(msg_load)
        loaded = fresh_tree["solver"]
        assert isinstance(loaded, PDVNamelist)
        assert loaded.format == "fortran"
        assert loaded.module_id == "nml_mod"

    def test_relative_paths_stored(self, tree_with_comm, tmp_save_dir):
        """After load, PDVFile nodes store relative (not absolute) paths."""
        working_dir = tree_with_comm._working_dir
        script_rel = os.path.join("tree", "demo.py")
        script_file = os.path.join(working_dir, script_rel)
        os.makedirs(os.path.dirname(script_file), exist_ok=True)
        with open(script_file, "w") as f:
            f.write("def run(pdv_tree: dict):\n    return {}\n")

        nodes = [
            {
                "path": "demo",
                "type": "script",
                "storage": {
                    "backend": "local_file",
                    "relative_path": script_rel,
                    "format": "py_script",
                },
                "metadata": {"language": "python", "preview": "script"},
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        script = tree_with_comm["demo"]
        assert isinstance(script, PDVScript)
        assert not os.path.isabs(script.relative_path)
        assert script.relative_path == script_rel

    def test_module_working_dir_propagated(self, tree_with_comm, tmp_save_dir):
        """After load, PDVModule subtree nodes share the root working dir."""
        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "has_children": True,
                "storage": {
                    "backend": "inline",
                    "format": "module_meta",
                    "value": {
                        "module_id": "prop_test",
                        "name": "PropTest",
                        "version": "1.0",
                    },
                },
                "metadata": {
                    "module_id": "prop_test",
                    "name": "PropTest",
                    "version": "1.0",
                    "preview": "",
                },
            },
        ]
        _write_tree_index(tmp_save_dir, nodes)
        mock_comm = _make_mock_comm()
        msg = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_load(msg)
        mod = tree_with_comm["mymod"]
        assert isinstance(mod, PDVModule)
        assert mod._working_dir == tree_with_comm._working_dir


class TestCompositeMapping:
    """Save/load round-trips for dicts containing non-JSON-native leaves.

    Reference: plan at /Users/pharr/.claude/plans/replicated-stirring-newt.md
    """

    def test_dict_of_ndarrays_save_load_roundtrip(
        self, tree_with_comm, tmp_save_dir
    ):
        """The exact audit repro: dict with ndarray values must save and load."""
        numpy = pytest.importorskip("numpy")
        arr_t = numpy.linspace(0, 1, 10)
        arr_x = numpy.sin(arr_t)
        arr_v = numpy.cos(arr_t)
        tree_with_comm["runs"] = PDVTree()
        tree_with_comm["runs.last"] = {
            "t": arr_t,
            "x": arr_x,
            "v": arr_v,
            "amplitude": 3.0,
        }

        mock_comm = _make_mock_comm()
        msg_save = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg_save)
        response = mock_comm._sent[-1]
        assert response["status"] == "ok", (
            f"save failed: {response.get('payload')}"
        )

        fresh_tree = PDVTree()
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm2),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(msg_load)

        loaded = fresh_tree["runs.last"]
        assert type(loaded) is dict, (
            f"expected plain dict, got {type(loaded).__name__}"
        )
        assert set(loaded.keys()) == {"t", "x", "v", "amplitude"}
        assert numpy.array_equal(loaded["t"], arr_t)
        assert numpy.array_equal(loaded["x"], arr_x)
        assert numpy.array_equal(loaded["v"], arr_v)
        assert loaded["amplitude"] == 3.0

    def test_composite_dict_with_raising_leaf_falls_back_per_leaf(
        self, tree_with_comm, tmp_save_dir
    ):
        """Per-leaf pickle fallback inside a composite dict: if one child makes
        serialize_node raise, only that child gets pickled. Siblings keep their
        fast paths. Uses a nested list-of-ndarrays (which raises by design) as
        the raising leaf."""
        numpy = pytest.importorskip("numpy")
        arr = numpy.array([1.0, 2.0, 3.0])
        raising_leaf = [numpy.array([1, 2]), numpy.array([3, 4])]
        tree_with_comm["data"] = {
            "arr": arr,
            "raising": raising_leaf,
            "scalar": 7,
        }

        mock_comm = _make_mock_comm()
        msg_save = _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(msg_save)
        response = mock_comm._sent[-1]
        assert response["status"] == "ok"

        with open(os.path.join(tmp_save_dir, "tree-index.json")) as f:
            nodes = json.load(f)
        by_path = {n["path"]: n for n in nodes}
        # Siblings take their native fast paths.
        assert by_path["data.arr"]["storage"]["format"] == "npy"
        assert by_path["data.scalar"]["storage"]["backend"] == "inline"
        # The raising leaf falls back to pickle via the walker.
        assert by_path["data.raising"]["storage"]["format"] == "pickle"
        assert by_path["data.raising"]["metadata"]["fallback"] == "pickle"

        fresh_tree = PDVTree()
        mock_comm2 = _make_mock_comm()
        msg_load = _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
        with (
            patch.object(comms_mod, "_comm", mock_comm2),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(msg_load)
        loaded = fresh_tree["data"]
        assert type(loaded) is dict
        assert numpy.array_equal(loaded["arr"], arr)
        assert loaded["scalar"] == 7
        assert len(loaded["raising"]) == 2
        assert numpy.array_equal(loaded["raising"][0], numpy.array([1, 2]))

    def test_nested_composite_mapping_roundtrip(
        self, tree_with_comm, tmp_save_dir
    ):
        """A dict-in-dict with ndarray at the innermost level round-trips."""
        numpy = pytest.importorskip("numpy")
        arr = numpy.arange(5)
        tree_with_comm["outer"] = {"inner": {"arr": arr, "tag": "hello"}}

        mock_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(
                _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
            )

        fresh_tree = PDVTree()
        mock_comm2 = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm2),
            patch.object(comms_mod, "_pdv_tree", fresh_tree),
        ):
            handle_project_load(
                _make_msg("pdv.project.load", {"save_dir": tmp_save_dir})
            )
        loaded = fresh_tree["outer"]
        assert type(loaded) is dict
        assert type(loaded["inner"]) is dict
        assert numpy.array_equal(loaded["inner"]["arr"], arr)
        assert loaded["inner"]["tag"] == "hello"

    def test_json_native_mapping_still_inline(
        self, tree_with_comm, tmp_save_dir
    ):
        """Regression: a pure JSON dict stays on the fast inline path."""
        tree_with_comm["meta"] = {"author": "Matt", "count": 3, "ok": True}
        mock_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(
                _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
            )
        with open(os.path.join(tmp_save_dir, "tree-index.json")) as f:
            nodes = json.load(f)
        meta_node = next(n for n in nodes if n["path"] == "meta")
        assert meta_node["storage"]["backend"] == "inline"
        assert meta_node["storage"]["value"] == {
            "author": "Matt",
            "count": 3,
            "ok": True,
        }
        assert not meta_node["metadata"].get("composite")
        # No child descriptors emitted for a JSON-native dict.
        child_paths = [n["path"] for n in nodes if n["path"].startswith("meta.")]
        assert child_paths == []

    def test_sequence_with_ndarray_falls_back_to_pickle_via_walker(
        self, tree_with_comm, tmp_save_dir
    ):
        """serialize_node raises a helpful error for list-of-ndarrays, but the
        walker's pickle fallback catches it so project.save still succeeds."""
        numpy = pytest.importorskip("numpy")
        tree_with_comm["seq"] = [numpy.array([1, 2]), numpy.array([3, 4])]
        mock_comm = _make_mock_comm()
        with (
            patch.object(comms_mod, "_comm", mock_comm),
            patch.object(comms_mod, "_pdv_tree", tree_with_comm),
        ):
            handle_project_save(
                _make_msg("pdv.project.save", {"save_dir": tmp_save_dir})
            )
        response = mock_comm._sent[-1]
        assert response["status"] == "ok"
        with open(os.path.join(tmp_save_dir, "tree-index.json")) as f:
            nodes = json.load(f)
        seq_node = next(n for n in nodes if n["path"] == "seq")
        assert seq_node["storage"]["format"] == "pickle"
        assert seq_node["metadata"]["fallback"] == "pickle"
