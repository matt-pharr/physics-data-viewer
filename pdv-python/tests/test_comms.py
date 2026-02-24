"""
pdv-python/tests/test_comms.py — Unit tests for pdv_kernel.comms.

Tests cover:
1. send_message() envelope construction.
2. send_error() convenience wrapper.
3. check_version() acceptance and rejection.
4. _on_comm_message() dispatch routing (integration with mock handlers).

All IPython comm objects are mocked — no live kernel is started.

Reference: ARCHITECTURE.md §3.2, §3.5, §3.6
"""

import uuid
import pytest
from unittest.mock import MagicMock, patch


class TestSendMessage:
    def test_envelope_structure(self):
        """send_message() produces a correctly structured PDV envelope."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_in_reply_to_is_set(self):
        """send_message() sets in_reply_to correctly."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_msg_id_is_uuid(self):
        """Each call produces a unique msg_id."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_raises_without_comm(self):
        """send_message() raises RuntimeError if no comm is open."""
        # TODO: implement in Step 2
        raise NotImplementedError


class TestSendError:
    def test_error_envelope(self):
        """send_error() produces an envelope with status='error'."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_error_payload_fields(self):
        """send_error() payload contains code and message."""
        # TODO: implement in Step 2
        raise NotImplementedError


class TestCheckVersion:
    def test_matching_version_ok(self):
        """check_version() does not raise when versions match."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_minor_version_mismatch_ok(self):
        """A minor version difference is tolerated."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_major_version_mismatch_raises(self):
        """A major version difference raises PDVVersionError."""
        # TODO: implement in Step 2
        raise NotImplementedError


class TestDispatch:
    def test_known_message_type_dispatched(self):
        """_on_comm_message() routes to the registered handler."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_unknown_message_type_returns_error(self):
        """_on_comm_message() sends a protocol.unknown_type error for unregistered types."""
        # TODO: implement in Step 2
        raise NotImplementedError
