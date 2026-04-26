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
