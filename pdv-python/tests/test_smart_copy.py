"""Tests for pdv.environment.smart_copy and UUID helpers."""

from __future__ import annotations

import os
import re
from unittest import mock

import pytest

from pdv.environment import generate_node_uuid, smart_copy, uuid_tree_path


class TestGenerateNodeUuid:
    def test_length(self) -> None:
        assert len(generate_node_uuid()) == 12

    def test_hex_chars(self) -> None:
        assert re.fullmatch(r"[0-9a-f]{12}", generate_node_uuid())

    def test_uniqueness(self) -> None:
        uuids = {generate_node_uuid() for _ in range(100)}
        assert len(uuids) == 100


class TestUuidTreePath:
    def test_basic(self) -> None:
        result = uuid_tree_path("/tmp/pdv-abc", "a1b2c3d4e5f6", "ch1.npy")
        assert result == os.path.join("/tmp/pdv-abc", "tree", "a1b2c3d4e5f6", "ch1.npy")

    def test_preserves_filename(self) -> None:
        result = uuid_tree_path("/work", "abc123def456", "n_pendulum.py")
        assert result.endswith("n_pendulum.py")


class TestSmartCopy:
    def test_copies_content(self, tmp_path: os.PathLike) -> None:
        src = tmp_path / "src.txt"
        src.write_text("hello world")
        dst = tmp_path / "dst.txt"
        smart_copy(str(src), str(dst))
        assert dst.read_text() == "hello world"

    def test_creates_parent_dirs(self, tmp_path: os.PathLike) -> None:
        src = tmp_path / "src.bin"
        src.write_bytes(b"\x00\x01\x02")
        dst = tmp_path / "deep" / "nested" / "dir" / "dst.bin"
        smart_copy(str(src), str(dst))
        assert dst.read_bytes() == b"\x00\x01\x02"

    def test_works_without_reflink(self, tmp_path: os.PathLike) -> None:
        src = tmp_path / "src.txt"
        src.write_text("data")
        dst = tmp_path / "dst.txt"
        with mock.patch.dict("sys.modules", {"reflink_copy": None}):
            smart_copy(str(src), str(dst))
        assert dst.read_text() == "data"

    def test_copies_binary_file(self, tmp_path: os.PathLike) -> None:
        src = tmp_path / "src.npy"
        content = bytes(range(256)) * 100
        src.write_bytes(content)
        dst = tmp_path / "out" / "dst.npy"
        smart_copy(str(src), str(dst))
        assert dst.read_bytes() == content

    def test_no_tmp_residue_after_success(self, tmp_path: os.PathLike) -> None:
        # smart_copy stages writes at `<dst>.tmp` and renames; on success
        # the temp must not be left behind.
        src = tmp_path / "src.txt"
        src.write_text("payload")
        dst = tmp_path / "dst.txt"
        smart_copy(str(src), str(dst))
        assert dst.read_text() == "payload"
        assert not (tmp_path / "dst.txt.tmp").exists()

    def test_overwrites_existing_destination(self, tmp_path: os.PathLike) -> None:
        # PDVFile-family nodes reuse the same UUID across saves, so smart_copy
        # is invoked with an existing dst on every save after the first.
        # Verify the new content lands at dst and no tmp lingers.
        src = tmp_path / "src.txt"
        src.write_text("new")
        dst = tmp_path / "dst.txt"
        dst.write_text("old")
        smart_copy(str(src), str(dst))
        assert dst.read_text() == "new"
        assert not (tmp_path / "dst.txt.tmp").exists()

    def test_destination_untouched_on_copy_failure(
        self,
        tmp_path: os.PathLike,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # If the underlying copy raises after the temp is partially written,
        # `dst` must be byte-for-byte unchanged and the temp must be removed.
        # We force the fallback to `shutil.copy2`, then patch it to write a
        # partial temp and raise — this is the realistic mid-copy crash
        # analogue.
        src = tmp_path / "src.txt"
        src.write_text("intended-new")
        dst = tmp_path / "dst.txt"
        dst.write_text("original")

        from pathlib import Path

        # Force-fallthrough past Path.copy (3.14+) and reflink_copy.
        if hasattr(Path, "copy"):
            monkeypatch.delattr(Path, "copy", raising=False)
        monkeypatch.setitem(__import__("sys").modules, "reflink_copy", None)

        def _fake_copy(srcp: str, dstp: str) -> None:
            with open(dstp, "wb") as fh:
                fh.write(b"partial")
            raise OSError(13, "Permission denied")

        import shutil as _shutil
        monkeypatch.setattr(_shutil, "copy2", _fake_copy)

        with pytest.raises(OSError):
            smart_copy(str(src), str(dst))

        # Destination still has the original content; temp is gone.
        assert dst.read_text() == "original"
        assert not (tmp_path / "dst.txt.tmp").exists()

    def test_byte_identical_destination_skips_copy(
        self,
        tmp_path: os.PathLike,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Fast path: if src and dst already have identical content, no I/O
        # should happen — in particular, no temp file should appear.
        src = tmp_path / "src.txt"
        src.write_text("same")
        dst = tmp_path / "dst.txt"
        dst.write_text("same")

        copy_calls: list[tuple[str, str]] = []

        def _fail_if_called(srcp: str, dstp: str) -> None:
            copy_calls.append((srcp, dstp))

        import shutil as _shutil
        monkeypatch.setattr(_shutil, "copy2", _fail_if_called)

        smart_copy(str(src), str(dst))
        assert copy_calls == []
        assert not (tmp_path / "dst.txt.tmp").exists()

    def test_stale_tmp_from_prior_crash_is_swept_on_fast_path(
        self, tmp_path: os.PathLike
    ) -> None:
        # If a previous SIGKILL or power loss left a `<dst>.tmp` behind,
        # smart_copy on the next byte-identical save must still sweep
        # it. Without the sweep, the stale tmp would persist
        # indefinitely because the byte-identical fast path returns
        # without ever touching the tmp path.
        src = tmp_path / "src.txt"
        src.write_text("intended")
        dst = tmp_path / "dst.txt"
        dst.write_text("intended")  # byte-identical to src
        stale = tmp_path / "dst.txt.tmp"
        stale.write_bytes(b"garbage from previous crash")

        smart_copy(str(src), str(dst))

        assert dst.read_text() == "intended"
        assert not stale.exists()

    def test_stale_tmp_swept_when_actual_write_happens(
        self, tmp_path: os.PathLike
    ) -> None:
        # When the contents differ and a real write is needed, the
        # stale tmp from a prior crash must be unlinked before staging
        # the new copy — otherwise the next write could land bytes
        # that share a path with stale data.
        src = tmp_path / "src.txt"
        src.write_text("new content")
        dst = tmp_path / "dst.txt"
        dst.write_text("old content")  # differs from src
        stale = tmp_path / "dst.txt.tmp"
        stale.write_bytes(b"garbage from previous crash")

        smart_copy(str(src), str(dst))

        assert dst.read_text() == "new content"
        assert not stale.exists()
