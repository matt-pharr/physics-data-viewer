"""
pdv-python/tests/test_query_server.py — Unit tests for QueryServer request
routing.

Exercises ``QueryServer._handle_request`` in isolation (no ZeroMQ socket): the
read-only whitelist, the handler-response capture via the thread-local sink,
and the not-allowed / no-response / internal-error reply envelopes.
"""

import json
from unittest.mock import patch

import pdv.comms as comms_mod
from pdv.query_server import QueryServer, _ALLOWED_TYPES


def _raw(msg_type, msg_id="q1", payload=None):
    """Build a JSON-encoded request payload as the REP socket would receive."""
    return json.dumps(
        {"type": msg_type, "msg_id": msg_id, "payload": payload or {}}
    ).encode("utf-8")


class TestHandleRequest:
    def test_rejects_non_whitelisted_type(self):
        # A mutating message must never be dispatched by the read-only server.
        srv = QueryServer(port=0)
        with patch("pdv.handlers.dispatch") as dispatch:
            resp = srv._handle_request(_raw("pdv.tree.delete"))
        dispatch.assert_not_called()
        assert resp["status"] == "error"
        assert resp["payload"]["code"] == "query.not_allowed"
        assert resp["in_reply_to"] == "q1"

    def test_returns_handler_reply_for_allowed_type(self):
        srv = QueryServer(port=0)
        reply = {
            "type": "pdv.tree.list.response",
            "status": "ok",
            "payload": {"nodes": []},
        }

        def fake_dispatch(_env):
            # A real handler routes its reply through the installed sink.
            comms_mod._thread_local.response_sink(reply)

        with patch("pdv.handlers.dispatch", side_effect=fake_dispatch):
            resp = srv._handle_request(_raw("pdv.tree.list"))
        assert resp is reply
        assert resp["status"] == "ok"

    def test_no_response_when_handler_stays_silent(self):
        # Handler dispatched but produced no reply → query.no_response.
        srv = QueryServer(port=0)
        with patch("pdv.handlers.dispatch"):  # default mock never touches the sink
            resp = srv._handle_request(_raw("pdv.tree.get"))
        assert resp["status"] == "error"
        assert resp["payload"]["code"] == "query.no_response"

    def test_internal_error_on_dispatch_exception(self):
        srv = QueryServer(port=0)
        with patch("pdv.handlers.dispatch", side_effect=RuntimeError("boom")):
            resp = srv._handle_request(_raw("pdv.help"))
        assert resp["status"] == "error"
        assert resp["payload"]["code"] == "query.internal_error"
        assert "boom" in resp["payload"]["message"]

    def test_malformed_json_returns_internal_error(self):
        srv = QueryServer(port=0)
        resp = srv._handle_request(b"not valid json{")
        assert resp["status"] == "error"
        assert resp["payload"]["code"] == "query.internal_error"

    def test_sink_is_cleared_after_dispatch(self):
        # The thread-local sink must not leak past a request, or a later
        # execution-thread reply could be misrouted into this server.
        srv = QueryServer(port=0)
        with patch("pdv.handlers.dispatch"):
            srv._handle_request(_raw("pdv.tree.get"))
        assert getattr(comms_mod._thread_local, "response_sink", None) is None


class TestWhitelist:
    def test_whitelist_excludes_mutating_types(self):
        for mutating in (
            "pdv.tree.delete",
            "pdv.tree.create_node",
            "pdv.tree.rename",
            "pdv.tree.move",
            "pdv.tree.duplicate",
            "pdv.project.save",
        ):
            assert mutating not in _ALLOWED_TYPES

    def test_whitelist_includes_core_read_queries(self):
        for readonly in ("pdv.tree.list", "pdv.tree.get", "pdv.namespace.query"):
            assert readonly in _ALLOWED_TYPES
