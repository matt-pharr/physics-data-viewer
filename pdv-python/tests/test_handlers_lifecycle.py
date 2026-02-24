"""
pdv-python/tests/test_handlers_lifecycle.py — Tests for lifecycle handlers.

Tests cover pdv.init handling:
1. Valid payload sets working_dir on the tree.
2. Missing working_dir in payload sends error response.
3. Non-existent working_dir path sends error response.
4. Response type is pdv.init.response.

Reference: ARCHITECTURE.md §4.1, §3.4
"""

import pytest
from unittest.mock import MagicMock, patch


class TestHandleInit:
    def test_valid_init_sets_working_dir(self, tmp_working_dir):
        """A valid pdv.init message configures the working dir on the tree."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_valid_init_sends_ok_response(self, tmp_working_dir):
        """A valid pdv.init sends pdv.init.response with status=ok."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_missing_working_dir_sends_error(self):
        """A payload missing working_dir sends status=error response."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_nonexistent_working_dir_sends_error(self):
        """A non-existent working_dir path sends status=error response."""
        # TODO: implement in Step 2
        raise NotImplementedError

    def test_in_reply_to_matches_request(self, tmp_working_dir):
        """The response in_reply_to matches the request msg_id."""
        # TODO: implement in Step 2
        raise NotImplementedError
