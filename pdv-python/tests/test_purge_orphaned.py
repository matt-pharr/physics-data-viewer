"""
Tests for _purge_orphaned_tree_files() in handlers/project.py.

Covers:
- Orphaned UUID directories are removed after save.
- Referenced UUID directories (via node uuid or storage uuid) are preserved.
- Non-UUID entries in tree/ are left alone.
- Empty tree dir or missing tree dir does not crash.
- Filesystem errors during rmtree are swallowed gracefully.
"""

import os

from pdv.handlers.project import _purge_orphaned_tree_files


class TestPurgeOrphanedTreeFiles:
    def test_removes_unreferenced_uuid_dirs(self, tmp_path):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()
        orphan = tree_dir / "aabbccddeeff"
        orphan.mkdir()
        (orphan / "data.npy").write_bytes(b"fake")

        _purge_orphaned_tree_files(str(tmp_path), [])

        assert not orphan.exists()

    def test_preserves_referenced_by_node_uuid(self, tmp_path):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()
        kept = tree_dir / "112233445566"
        kept.mkdir()
        (kept / "script.py").write_text("pass")

        nodes = [{"uuid": "112233445566", "storage": {}}]
        _purge_orphaned_tree_files(str(tmp_path), nodes)

        assert kept.exists()

    def test_preserves_referenced_by_storage_uuid(self, tmp_path):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()
        kept = tree_dir / "aabb11223344"
        kept.mkdir()
        (kept / "arr.npy").write_bytes(b"data")

        nodes = [{"storage": {"uuid": "aabb11223344"}}]
        _purge_orphaned_tree_files(str(tmp_path), nodes)

        assert kept.exists()

    def test_ignores_non_uuid_entries(self, tmp_path):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()
        not_uuid = tree_dir / "not-a-uuid-dir"
        not_uuid.mkdir()

        _purge_orphaned_tree_files(str(tmp_path), [])

        assert not_uuid.exists()

    def test_ignores_files_not_dirs(self, tmp_path):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()
        stray_file = tree_dir / "aabbccddeeff"
        stray_file.write_text("not a dir")

        _purge_orphaned_tree_files(str(tmp_path), [])

        assert stray_file.exists()

    def test_no_tree_dir_is_noop(self, tmp_path):
        _purge_orphaned_tree_files(str(tmp_path), [])

    def test_mixed_referenced_and_orphaned(self, tmp_path):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()

        ref_uuid = "111111111111"
        orphan_uuid = "222222222222"
        (tree_dir / ref_uuid).mkdir()
        (tree_dir / ref_uuid / "data.npy").write_bytes(b"keep")
        (tree_dir / orphan_uuid).mkdir()
        (tree_dir / orphan_uuid / "old.npy").write_bytes(b"remove")

        nodes = [{"uuid": ref_uuid, "storage": {}}]
        _purge_orphaned_tree_files(str(tmp_path), nodes)

        assert (tree_dir / ref_uuid).exists()
        assert not (tree_dir / orphan_uuid).exists()

    def test_rmtree_error_is_swallowed(self, tmp_path, monkeypatch):
        tree_dir = tmp_path / "tree"
        tree_dir.mkdir()
        orphan = tree_dir / "aabbccddeeff"
        orphan.mkdir()

        import shutil
        original_rmtree = shutil.rmtree

        def failing_rmtree(path, **kwargs):
            raise OSError("permission denied")

        monkeypatch.setattr(shutil, "rmtree", failing_rmtree)

        _purge_orphaned_tree_files(str(tmp_path), [])

        monkeypatch.setattr(shutil, "rmtree", original_rmtree)
        assert orphan.exists()
