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
    # TODO: implement in Step 2
    raise NotImplementedError


register("pdv.init", handle_init)
