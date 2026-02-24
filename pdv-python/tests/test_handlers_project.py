"""
pdv-python/tests/test_handlers_project.py — Tests for project save/load handlers.

Tests cover:
1. pdv.project.load: reads tree-index.json, populates lazy registry, builds tree.
2. pdv.project.load: nonexistent save_dir sends error.
3. pdv.project.load: pushes pdv.project.loaded notification.
4. pdv.project.save: writes tree-index.json, writes data files.
5. pdv.project.save: response includes node_count and checksum.

Reference: ARCHITECTURE.md §4.2, §8
"""

import pytest
from unittest.mock import MagicMock, patch


class TestHandleProjectLoad:
    def test_loads_tree_from_index(self, tree_with_comm, tmp_save_dir):
        """handle_project_load() reads tree-index.json and builds the tree skeleton."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_lazy_nodes_registered(self, tree_with_comm, tmp_save_dir):
        """Lazy nodes from tree-index.json are registered in the lazy-load registry."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_sends_project_loaded_push(self, tree_with_comm, tmp_save_dir):
        """After loading, pdv.project.loaded push notification is sent."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_nonexistent_save_dir_sends_error(self, tree_with_comm):
        """A non-existent save_dir sends status=error response."""
        # TODO: implement in Step 2
        raise NotImplementedError


class TestHandleProjectSave:
    def test_writes_tree_index(self, tree_with_comm, tmp_save_dir):
        """handle_project_save() writes tree-index.json to the save directory."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_writes_data_files(self, tree_with_comm, tmp_save_dir):
        """Data files are written for each serializable node."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_response_has_node_count(self, tree_with_comm, tmp_save_dir):
        """Response payload includes node_count."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_response_has_checksum(self, tree_with_comm, tmp_save_dir):
        """Response payload includes checksum of tree-index.json."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_save_load_roundtrip(self, tree_with_comm, tmp_save_dir):
        """Save then load produces an isomorphic tree."""
        # TODO: implement in Step 2
        raise NotImplementedError
