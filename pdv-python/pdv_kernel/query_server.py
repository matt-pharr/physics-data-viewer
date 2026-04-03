"""
pdv_kernel.query_server — Dedicated ZeroMQ thread for read-only tree/namespace queries.

Runs a ZMQ REP socket on a separate daemon thread so that tree browsing
and namespace inspection work even while the main thread is executing
user code.  Only a whitelist of read-only message types is accepted.

The thread captures handler responses via a thread-local ``response_sink``
in :mod:`pdv_kernel.comms`, so existing handlers need no modification.

See Also
--------
ARCHITECTURE.md §3 (PDV Communication Protocol)
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# Read-only message types that are safe to run concurrently with execution.
_ALLOWED_TYPES: frozenset[str] = frozenset(
    {
        "pdv.tree.list",
        "pdv.tree.get",
        "pdv.tree.resolve_file",
        "pdv.namespace.query",
        "pdv.namespace.inspect",
    }
)


class QueryServer:
    """ZeroMQ REP server for read-only kernel queries.

    Parameters
    ----------
    port : int
        TCP port to bind the REP socket on ``127.0.0.1``.
    """

    def __init__(self, port: int) -> None:
        self._port = port
        self._shutdown = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the query server daemon thread."""
        if self._thread is not None:
            return
        self._shutdown.clear()
        self._thread = threading.Thread(
            target=self._run, name="pdv-query-server", daemon=True
        )
        self._thread.start()
        logger.info("QueryServer started on port %d", self._port)

    def stop(self) -> None:
        """Signal the thread to stop and wait for it to finish."""
        self._shutdown.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        logger.info("QueryServer stopped")

    # ------------------------------------------------------------------
    # Thread target
    # ------------------------------------------------------------------

    def _run(self) -> None:
        """Main loop for the query thread (runs in a daemon thread)."""
        import zmq  # noqa: PLC0415 — deferred so module loads without zmq

        from pdv_kernel import __version__ as PDV_PROTOCOL_VERSION  # noqa: PLC0415
        from pdv_kernel import comms as comms_mod  # noqa: PLC0415
        from pdv_kernel.handlers import dispatch  # noqa: PLC0415

        ctx = zmq.Context.instance()
        sock = ctx.socket(zmq.REP)
        sock.linger = 0
        try:
            sock.bind(f"tcp://127.0.0.1:{self._port}")
        except zmq.ZMQError:
            logger.error("QueryServer failed to bind to port %d", self._port)
            return

        poller = zmq.Poller()
        poller.register(sock, zmq.POLLIN)

        while not self._shutdown.is_set():
            events = dict(poller.poll(timeout=100))  # 100ms
            if sock not in events:
                continue

            raw = sock.recv()
            # REP socket contract: every recv MUST be followed by a send.
            # Use try/finally to guarantee a reply even on unexpected errors.
            response: dict[str, Any] | None = None
            envelope: dict[str, Any] = {}
            try:
                envelope = json.loads(raw)
                msg_type = envelope.get("type", "")
                msg_id = envelope.get("msg_id", str(uuid.uuid4()))

                if msg_type not in _ALLOWED_TYPES:
                    response = {
                        "pdv_version": PDV_PROTOCOL_VERSION,
                        "msg_id": str(uuid.uuid4()),
                        "in_reply_to": msg_id,
                        "type": f"{msg_type}.response",
                        "status": "error",
                        "payload": {
                            "code": "query.not_allowed",
                            "message": f"Message type '{msg_type}' is not a read-only query",
                        },
                    }
                else:
                    # Capture the handler's response via thread-local sink.
                    captured: list[dict] = []
                    comms_mod._thread_local.response_sink = lambda env: captured.append(env)
                    try:
                        dispatch(envelope)
                    finally:
                        comms_mod._thread_local.response_sink = None

                    if captured:
                        response = captured[0]
                    else:
                        response = {
                            "pdv_version": PDV_PROTOCOL_VERSION,
                            "msg_id": str(uuid.uuid4()),
                            "in_reply_to": msg_id,
                            "type": f"{msg_type}.response",
                            "status": "error",
                            "payload": {
                                "code": "query.no_response",
                                "message": "Handler did not produce a response",
                            },
                        }
            except Exception as exc:  # noqa: BLE001
                logger.exception("QueryServer error processing message")
                response = {
                    "pdv_version": PDV_PROTOCOL_VERSION,
                    "msg_id": str(uuid.uuid4()),
                    "in_reply_to": envelope.get("msg_id", ""),
                    "type": "query.error",
                    "status": "error",
                    "payload": {
                        "code": "query.internal_error",
                        "message": str(exc),
                    },
                }
            finally:
                # Always send a reply — if response is somehow None, send a
                # generic error so the REP socket doesn't get stuck.
                if response is None:
                    response = {
                        "pdv_version": PDV_PROTOCOL_VERSION,
                        "msg_id": str(uuid.uuid4()),
                        "in_reply_to": envelope.get("msg_id", ""),
                        "type": "query.error",
                        "status": "error",
                        "payload": {
                            "code": "query.internal_error",
                            "message": "No response produced",
                        },
                    }
                sock.send(json.dumps(response).encode("utf-8"))

        sock.close()
