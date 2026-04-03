"""
pdv_kernel.handlers.lifecycle — Handlers for PDV lifecycle messages.

Handles:
- ``pdv.init``: receives the working directory path and initial config
  from the app. Validates and sets up the working directory. Sends
  ``pdv.init.response``.

See Also
--------
ARCHITECTURE.md §4.1 (startup sequence), §3.4 (lifecycle messages)
"""

from __future__ import annotations

import os

from pdv_kernel.handlers import register


def handle_init(msg: dict) -> None:
    """Handle the ``pdv.init`` message from the app.

    Called immediately after the app receives ``pdv.ready``. The payload
    contains the working directory path and protocol version.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "working_dir": "/tmp/pdv-<uuid>",
            "pdv_version": "1.0"
        }

    Response type: ``pdv.init.response``

    On success, ``status='ok'`` with empty payload.
    On failure, ``status='error'`` with ``code`` and ``message``.

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.environment import validate_working_dir  # noqa: PLC0415
    from pdv_kernel.errors import PDVPathError  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    working_dir = payload.get("working_dir")

    if not working_dir:
        send_error(
            "pdv.init.response",
            "init.missing_working_dir",
            "working_dir is required in the pdv.init payload",
            in_reply_to=msg_id,
        )
        return

    try:
        validated = validate_working_dir(working_dir)
    except PDVPathError as exc:
        send_error(
            "pdv.init.response",
            "init.invalid_working_dir",
            str(exc),
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is not None:
        tree._set_working_dir(validated)

    # Start the query server if a query_port was provided.
    query_port = payload.get("query_port")
    if query_port is not None:
        import pdv_kernel.comms as comms_mod  # noqa: PLC0415
        from pdv_kernel.query_server import QueryServer  # noqa: PLC0415

        # Stop any existing server (e.g. on kernel restart with new init).
        if comms_mod._query_server is not None:
            comms_mod._query_server.stop()
        server = QueryServer(int(query_port))
        server.start()
        comms_mod._query_server = server

    os.chdir(os.path.expanduser("~"))
    send_message("pdv.init.response", {}, in_reply_to=msg_id)


register("pdv.init", handle_init)
