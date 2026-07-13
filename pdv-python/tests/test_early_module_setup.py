"""
Tests for _early_module_setup() in handlers/project.py.

Covers:
- Lib directories are inserted into sys.path.
- Entry points are imported via importlib.
- Missing pdv-module.json is skipped gracefully.
- Invalid JSON in pdv-module.json is skipped gracefully.
- Missing entry_point key is skipped.
- Failed entry point import logs warning but doesn't abort.
- Duplicate lib dirs are not added to sys.path twice.
"""

import json
import os
import sys

import pytest

from pdv.handlers.project import _early_module_setup


class TestEarlyModuleSetup:
    def test_lib_dir_added_to_sys_path(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)
        os.makedirs(save_dir)

        lib_uuid = "lib_uuid_0001"
        lib_dir = os.path.join(working_dir, "tree", lib_uuid)
        os.makedirs(lib_dir)

        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "metadata": {"module_id": "test_mod"},
                "storage": {"value": {}},
            },
            {
                "path": "mymod.lib.helpers",
                "type": "lib",
                "uuid": lib_uuid,
                "storage": {"uuid": lib_uuid, "filename": "helpers.py"},
            },
        ]

        try:
            _early_module_setup(nodes, save_dir, working_dir)
            assert lib_dir in sys.path
        finally:
            if lib_dir in sys.path:
                sys.path.remove(lib_dir)

    def test_entry_point_imported(self, tmp_path):
        # Use a uniquely-named module that is NOT already imported, dropped
        # into a lib dir that _early_module_setup wires onto sys.path — so the
        # assertion actually proves the entry point was imported. (A stdlib
        # name like "json" is vacuous: it is always already in sys.modules.)
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)

        entry_name = "dummy_pdv_entrypoint_mod_xyz"
        lib_uuid = "entrypoint_lib_0001"
        lib_dir = os.path.join(working_dir, "tree", lib_uuid)
        os.makedirs(lib_dir)
        with open(os.path.join(lib_dir, f"{entry_name}.py"), "w") as f:
            f.write("IMPORTED = True\n")

        mod_dir = os.path.join(save_dir, "modules", "test_mod")
        os.makedirs(mod_dir)
        manifest = {"entry_point": entry_name}
        with open(os.path.join(mod_dir, "pdv-module.json"), "w") as f:
            json.dump(manifest, f)

        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "metadata": {"module_id": "test_mod"},
                "storage": {"value": {}},
            },
            {
                "path": "mymod.lib.entry",
                "type": "lib",
                "uuid": lib_uuid,
                "storage": {"uuid": lib_uuid, "filename": f"{entry_name}.py"},
            },
        ]

        assert entry_name not in sys.modules  # precondition: genuinely fresh
        try:
            _early_module_setup(nodes, save_dir, working_dir)
            assert entry_name in sys.modules
            assert getattr(sys.modules[entry_name], "IMPORTED", False) is True
        finally:
            sys.modules.pop(entry_name, None)
            if lib_dir in sys.path:
                sys.path.remove(lib_dir)

    def test_missing_manifest_skipped(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)
        os.makedirs(save_dir)

        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "metadata": {"module_id": "no_manifest_mod"},
                "storage": {"value": {}},
            },
        ]

        _early_module_setup(nodes, save_dir, working_dir)

    def test_invalid_json_manifest_skipped(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)

        mod_dir = os.path.join(save_dir, "modules", "bad_json_mod")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "pdv-module.json"), "w") as f:
            f.write("{broken json")

        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "metadata": {"module_id": "bad_json_mod"},
                "storage": {"value": {}},
            },
        ]

        _early_module_setup(nodes, save_dir, working_dir)

    def test_missing_entry_point_key_skipped(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)

        mod_dir = os.path.join(save_dir, "modules", "no_ep_mod")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "pdv-module.json"), "w") as f:
            json.dump({"name": "No EP"}, f)

        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "metadata": {"module_id": "no_ep_mod"},
                "storage": {"value": {}},
            },
        ]

        _early_module_setup(nodes, save_dir, working_dir)

    def test_failed_import_logs_warning_does_not_abort(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)

        mod_dir = os.path.join(save_dir, "modules", "bad_import_mod")
        os.makedirs(mod_dir)
        manifest = {"entry_point": "nonexistent_module_pdv_test_xyz"}
        with open(os.path.join(mod_dir, "pdv-module.json"), "w") as f:
            json.dump(manifest, f)

        nodes = [
            {
                "path": "mymod",
                "type": "module",
                "metadata": {"module_id": "bad_import_mod"},
                "storage": {"value": {}},
            },
        ]

        _early_module_setup(nodes, save_dir, working_dir)

    def test_duplicate_lib_dirs_not_added_twice(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)
        os.makedirs(save_dir)

        lib_uuid = "dup_lib_00001"
        lib_dir = os.path.join(working_dir, "tree", lib_uuid)
        os.makedirs(lib_dir)

        nodes = [
            {
                "path": "mymod.lib.a",
                "type": "lib",
                "uuid": lib_uuid,
                "storage": {"uuid": lib_uuid, "filename": "a.py"},
            },
            {
                "path": "mymod.lib.b",
                "type": "lib",
                "uuid": lib_uuid,
                "storage": {"uuid": lib_uuid, "filename": "b.py"},
            },
        ]

        try:
            _early_module_setup(nodes, save_dir, working_dir)
            count = sys.path.count(lib_dir)
            assert count == 1
        finally:
            while lib_dir in sys.path:
                sys.path.remove(lib_dir)

    def test_no_module_nodes_is_noop(self, tmp_path):
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)
        os.makedirs(save_dir)

        nodes = [
            {
                "path": "data.x",
                "type": "scalar",
                "storage": {"backend": "inline", "value": 42},
            },
        ]

        _early_module_setup(nodes, save_dir, working_dir)

    def test_lib_uuid_from_storage_fallback(self, tmp_path):
        """Lib node without top-level uuid falls back to storage.uuid."""
        working_dir = str(tmp_path / "work")
        save_dir = str(tmp_path / "save")
        os.makedirs(working_dir)
        os.makedirs(save_dir)

        lib_uuid = "fallback_0001"
        lib_dir = os.path.join(working_dir, "tree", lib_uuid)
        os.makedirs(lib_dir)

        nodes = [
            {
                "path": "mymod.lib.helpers",
                "type": "lib",
                "storage": {"uuid": lib_uuid, "filename": "helpers.py"},
            },
        ]

        try:
            _early_module_setup(nodes, save_dir, working_dir)
            assert lib_dir in sys.path
        finally:
            if lib_dir in sys.path:
                sys.path.remove(lib_dir)
