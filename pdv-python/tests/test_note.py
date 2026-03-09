"""
pdv-python/tests/test_note.py — Tests for PDVNote and markdown note support.

Tests cover:
1. PDVNote class construction, properties, preview, repr.
2. detect_kind() for PDVNote.
3. serialize_node() for markdown nodes.
4. deserialize_node() for markdown format.
5. node_preview() for markdown kind.
6. handle_note_register handler.
7. pdv.new_note() convenience method.

Reference: PLANNED_FEATURES.md Feature 4 (Markdown Notes in the Tree)
"""

import os
import uuid
from unittest.mock import MagicMock, patch

import pytest

import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.note import handle_note_register
from pdv_kernel.namespace import PDVApp
from pdv_kernel.serialization import (
    FORMAT_MARKDOWN,
    KIND_MARKDOWN,
    detect_kind,
    deserialize_node,
    node_preview,
    serialize_node,
)
from pdv_kernel.tree import PDVNote, PDVTree


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(payload, msg_id=None):
    return {
        "pdv_version": comms_mod.PDV_PROTOCOL_VERSION,
        "msg_id": msg_id or str(uuid.uuid4()),
        "in_reply_to": None,
        "type": "pdv.note.register",
        "payload": payload,
    }


# ---------------------------------------------------------------------------
# PDVNote class
# ---------------------------------------------------------------------------

class TestPDVNote:
    """Tests for the PDVNote wrapper class."""

    def test_construction_stores_path(self):
        note = PDVNote(relative_path="/tmp/notes/intro.md")
        assert note.relative_path == "/tmp/notes/intro.md"

    def test_construction_stores_title(self):
        note = PDVNote(relative_path="intro.md", title="Introduction")
        assert note.title == "Introduction"

    def test_title_defaults_to_none(self):
        note = PDVNote(relative_path="intro.md")
        assert note.title is None

    def test_preview_returns_title_when_set(self):
        note = PDVNote(relative_path="intro.md", title="My Title")
        assert note.preview() == "My Title"

    def test_preview_reads_first_line_from_file(self, tmp_path):
        md_file = tmp_path / "test.md"
        md_file.write_text("# Hello World\n\nSome content.\n")
        note = PDVNote(relative_path=str(md_file))
        assert note.preview() == "Hello World"

    def test_preview_skips_empty_lines(self, tmp_path):
        md_file = tmp_path / "test.md"
        md_file.write_text("\n\n\n## Section Title\n")
        note = PDVNote(relative_path=str(md_file))
        assert note.preview() == "Section Title"

    def test_preview_fallback_when_file_missing(self):
        note = PDVNote(relative_path="/nonexistent/path.md")
        assert note.preview() == "Markdown note"

    def test_preview_fallback_for_empty_file(self, tmp_path):
        md_file = tmp_path / "empty.md"
        md_file.write_text("")
        note = PDVNote(relative_path=str(md_file))
        assert note.preview() == "Markdown note"

    def test_preview_truncates_long_titles(self):
        note = PDVNote(relative_path="x.md", title="A" * 200)
        assert len(note.preview()) == 100

    def test_repr(self):
        note = PDVNote(relative_path="notes/intro.md")
        assert repr(note) == "PDVNote('notes/intro.md')"


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

class TestDetectKindMarkdown:
    """Tests for detect_kind() with PDVNote."""

    def test_pdvnote_returns_markdown(self):
        note = PDVNote(relative_path="test.md")
        assert detect_kind(note) == KIND_MARKDOWN

    def test_pdvnote_distinct_from_text(self):
        assert detect_kind("plain string") != KIND_MARKDOWN


class TestSerializeMarkdown:
    """Tests for serialize_node() with markdown nodes."""

    def test_serialize_creates_md_file(self, tmp_path):
        source = tmp_path / "source.md"
        source.write_text("# My Note\n\nHello world.\n")
        note = PDVNote(relative_path=str(source))

        descriptor = serialize_node("notes.intro", note, str(tmp_path))

        assert descriptor["type"] == KIND_MARKDOWN
        assert descriptor["language"] == "markdown"
        assert descriptor["storage"]["backend"] == "local_file"
        assert descriptor["storage"]["format"] == FORMAT_MARKDOWN
        assert descriptor["storage"]["relative_path"].endswith(".md")

        # Verify the file exists at the serialized location
        rel_path = descriptor["storage"]["relative_path"]
        abs_path = os.path.join(str(tmp_path), rel_path)
        assert os.path.exists(abs_path)
        with open(abs_path, "r") as f:
            assert f.read() == "# My Note\n\nHello world.\n"

    def test_serialize_copies_file_to_tree_dir(self, tmp_path):
        source_dir = tmp_path / "workspace"
        source_dir.mkdir()
        source = source_dir / "original.md"
        source.write_text("Content here.")
        note = PDVNote(relative_path=str(source))

        descriptor = serialize_node("docs.readme", note, str(tmp_path))

        rel = descriptor["storage"]["relative_path"]
        assert "tree" in rel  # File is stored under tree/ directory

    def test_serialize_raises_for_missing_file(self, tmp_path):
        note = PDVNote(relative_path="/nonexistent/file.md")
        with pytest.raises(Exception):
            serialize_node("notes.missing", note, str(tmp_path))

    def test_serialize_preview_from_file(self, tmp_path):
        source = tmp_path / "source.md"
        source.write_text("# Physics Notes\n\nSome equations.\n")
        note = PDVNote(relative_path=str(source))

        descriptor = serialize_node("notes.physics", note, str(tmp_path))
        assert descriptor["preview"] == "Physics Notes"


class TestDeserializeMarkdown:
    """Tests for deserialize_node() with markdown format."""

    def test_deserialize_reads_md_content(self, tmp_path):
        md_file = tmp_path / "tree" / "notes" / "intro.md"
        md_file.parent.mkdir(parents=True)
        md_file.write_text("# Hello\n\nWorld.\n")

        storage_ref = {
            "backend": "local_file",
            "relative_path": "tree/notes/intro.md",
            "format": FORMAT_MARKDOWN,
        }
        result = deserialize_node(storage_ref, str(tmp_path))
        assert result == "# Hello\n\nWorld.\n"

    def test_deserialize_raises_for_missing_file(self, tmp_path):
        storage_ref = {
            "backend": "local_file",
            "relative_path": "tree/notes/missing.md",
            "format": FORMAT_MARKDOWN,
        }
        with pytest.raises(FileNotFoundError):
            deserialize_node(storage_ref, str(tmp_path))


class TestNodePreviewMarkdown:
    """Tests for node_preview() with markdown kind."""

    def test_preview_with_titled_note(self):
        note = PDVNote(relative_path="x.md", title="Analysis Results")
        assert node_preview(note, KIND_MARKDOWN) == "Analysis Results"

    def test_preview_with_file_note(self, tmp_path):
        md_file = tmp_path / "test.md"
        md_file.write_text("## Section One\n")
        note = PDVNote(relative_path=str(md_file))
        assert node_preview(note, KIND_MARKDOWN) == "Section One"

    def test_preview_fallback(self):
        note = PDVNote(relative_path="/nonexistent.md")
        assert node_preview(note, KIND_MARKDOWN) == "Markdown note"


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

class TestHandleNoteRegister:
    """Tests for the pdv.note.register handler."""

    def test_valid_register_attaches_note_to_tree(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg({
            "parent_path": "notes",
            "name": "introduction",
            "relative_path": "notes/introduction.md",
        })
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            handle_note_register(msg)

        node = tree["notes.introduction"]
        assert isinstance(node, PDVNote)
        assert node.relative_path == "notes/introduction.md"
        response = mock_comm._sent[-1]
        assert response["type"] == "pdv.note.register.response"
        assert response["status"] == "ok"
        assert response["payload"]["path"] == "notes.introduction"

    def test_register_missing_name_sends_error(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg({"parent_path": "notes", "relative_path": "notes/x.md"})
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            handle_note_register(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "note.missing_name"

    def test_register_missing_relative_path_sends_error(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg({"parent_path": "notes", "name": "x"})
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            handle_note_register(msg)

        response = mock_comm._sent[0]
        assert response["status"] == "error"
        assert response["payload"]["code"] == "note.missing_relative_path"

    def test_register_at_root_path(self):
        tree = PDVTree()
        mock_comm = _make_mock_comm()
        msg = _make_msg({
            "parent_path": "",
            "name": "readme",
            "relative_path": "readme.md",
        })
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            handle_note_register(msg)

        assert isinstance(tree["readme"], PDVNote)

    def test_register_emits_tree_changed_notification(self):
        tree = PDVTree()
        tree._attach_comm(lambda msg_type, payload: comms_mod.send_message(msg_type, payload))
        mock_comm = _make_mock_comm()
        msg = _make_msg({
            "parent_path": "notes",
            "name": "new_note",
            "relative_path": "notes/new_note.md",
        })
        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            handle_note_register(msg)

        types = [envelope["type"] for envelope in mock_comm._sent]
        assert "pdv.tree.changed" in types
        assert "pdv.note.register.response" in types


# ---------------------------------------------------------------------------
# PDVApp.new_note()
# ---------------------------------------------------------------------------

class TestPDVAppNewNote:
    """Tests for pdv.new_note() convenience method."""

    def test_new_note_creates_file_and_tree_node(self, tmp_path):
        tree = PDVTree()
        tree._working_dir = str(tmp_path)
        mock_comm = _make_mock_comm()
        app = PDVApp()

        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            app.new_note("notes.intro", title="Introduction")

        node = tree["notes.intro"]
        assert isinstance(node, PDVNote)
        assert node.title == "Introduction"
        # File should exist
        assert os.path.exists(node.relative_path)
        content = open(node.relative_path, "r").read()
        assert content.startswith("# Introduction")

    def test_new_note_without_title_creates_empty_file(self, tmp_path):
        tree = PDVTree()
        tree._working_dir = str(tmp_path)
        mock_comm = _make_mock_comm()
        app = PDVApp()

        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            app.new_note("scratch")

        node = tree["scratch"]
        assert isinstance(node, PDVNote)
        content = open(node.relative_path, "r").read()
        assert content == ""

    def test_new_note_does_not_overwrite_existing_file(self, tmp_path):
        tree = PDVTree()
        tree._working_dir = str(tmp_path)
        mock_comm = _make_mock_comm()
        app = PDVApp()

        # Pre-create the file
        md_file = tmp_path / "existing.md"
        md_file.write_text("Existing content")

        with patch.object(comms_mod, "_comm", mock_comm), \
             patch.object(comms_mod, "_pdv_tree", tree):
            app.new_note("existing", title="New Title")

        content = open(tree["existing"].relative_path, "r").read()
        assert content == "Existing content"


# ---------------------------------------------------------------------------
# Serialization round-trip
# ---------------------------------------------------------------------------

class TestMarkdownRoundTrip:
    """Tests for serialize → deserialize round-trip with markdown nodes."""

    def test_roundtrip_preserves_content(self, tmp_path):
        original_content = "# Physics Derivation\n\n$$E = mc^2$$\n\nMore text.\n"
        source = tmp_path / "deriv.md"
        source.write_text(original_content)
        note = PDVNote(relative_path=str(source))

        descriptor = serialize_node("notes.derivation", note, str(tmp_path))
        restored = deserialize_node(descriptor["storage"], str(tmp_path))

        assert restored == original_content
