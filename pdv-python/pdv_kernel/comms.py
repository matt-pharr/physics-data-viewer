"""
pdv_kernel.comms — PDV comm channel registration, message dispatch, and sending.

This module is the kernel-side comm layer. It:

1. Registers the ``pdv.kernel`` comm target with IPython on bootstrap.
2. Receives incoming comm messages and dispatches them to the appropriate
   handler in ``pdv_kernel.handlers``.
3. Provides ``send_message()`` for building and sending correctly
   enveloped PDV messages back to the app.

Message envelope format is defined in ARCHITECTURE.md §3.2.
The full message type catalogue is in ARCHITECTURE.md §3.4.

This module depends on IPython being available. In tests, the IPython
comm is mocked — see ``tests/conftest.py``.

See Also
--------
ARCHITECTURE.md §3 (PDV Communication Protocol)
ARCHITECTURE.md §5.3 (bootstrap)
"""

from __future__ import annotations

import sys
import threading
import uuid
from typing import Any, Callable

from pdv_kernel.errors import PDVVersionError

from pdv_kernel import __version__ as PDV_PROTOCOL_VERSION
PDV_COMM_TARGET = "pdv.kernel"

# The single global comm instance (set on bootstrap, None before that).
_comm: Any = None

# Flag to prevent double-bootstrap.
_bootstrapped: bool = False

# Reference to the PDVTree and IPython shell (set by bootstrap).
_pdv_tree: Any = None
_ip: Any = None

# Reference to the query server (set on init, None before that).
_query_server: Any = None

# Thread-local storage for the query thread's response sink.
# When set, send_message() routes the envelope to the sink instead of the comm.
_thread_local = threading.local()


def send_message(
    msg_type: str,
    payload: dict,
    *,
    status: str = "ok",
    in_reply_to: str | None = None,
) -> None:
    """Send a PDV message from the kernel to the app.

    Constructs the standard PDV envelope (ARCHITECTURE.md §3.2) and
    sends it on the open comm channel.

    Parameters
    ----------
    msg_type : str
        Dot-namespaced message type string (e.g. ``'pdv.tree.list.response'``).
    payload : dict
        Message payload. Must be JSON-serializable.
    status : str
        ``'ok'`` or ``'error'``. Default ``'ok'``.
    in_reply_to : str or None
        The ``msg_id`` of the request being replied to.
        ``None`` for unsolicited push notifications.

    Raises
    ------
    RuntimeError
        If called before bootstrap (no comm is open).
    """
    envelope = {
        "pdv_version": PDV_PROTOCOL_VERSION,
        "msg_id": str(uuid.uuid4()),
        "in_reply_to": in_reply_to,
        "type": msg_type,
        "status": status,
        "payload": payload,
    }
    # If running on the query thread, route through the thread-local sink
    # instead of the comm channel.
    sink = getattr(_thread_local, "response_sink", None)
    if sink is not None:
        sink(envelope)
        return
    global _comm
    if _comm is None:
        raise RuntimeError(
            "No PDV comm channel is open. Was bootstrap() called before send_message()?"
        )
    _comm.send(data=envelope)


def send_error(
    msg_type: str,
    code: str,
    message: str,
    in_reply_to: str | None = None,
) -> None:
    """Send a PDV error response.

    Convenience wrapper around :func:`send_message` with ``status='error'``
    and a standard error payload (ARCHITECTURE.md §3.5).

    Parameters
    ----------
    msg_type : str
        Response type string (e.g. ``'pdv.tree.list.response'``).
    code : str
        Machine-readable error code (e.g. ``'tree.path_not_found'``).
    message : str
        Human-readable error description for display in the UI.
    in_reply_to : str or None
        The ``msg_id`` of the request being replied to.
    """
    send_message(
        msg_type,
        {"code": code, "message": message},
        status="error",
        in_reply_to=in_reply_to,
    )


def check_version(msg: dict) -> None:
    """Validate the ``pdv_version`` field of an incoming message.

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.

    Raises
    ------
    PDVVersionError
        If the major version component of ``msg['pdv_version']`` differs
        from :data:`PDV_PROTOCOL_VERSION`. A minor/patch mismatch is
        logged but tolerated. See ARCHITECTURE.md §3.6.
    """
    incoming = str(msg.get("pdv_version", ""))
    expected_parts = PDV_PROTOCOL_VERSION.split(".")
    incoming_parts = incoming.split(".") if incoming else []
    expected_major = expected_parts[0] if expected_parts else "0"
    incoming_major = incoming_parts[0] if incoming_parts else ""
    # During 0.x, major mismatch rejects; minor/patch mismatch warns.
    # Post-1.0, consider relaxing to tolerate patch-level differences.
    # NOTE: Same version policy is enforced in pdv-protocol.ts
    # (checkVersionCompatibility) and environment-detector.ts (checkPDVInstalled).
    if incoming_major != expected_major:
        raise PDVVersionError(
            f"Incompatible PDV version: got '{incoming}', "
            f"expected major version '{expected_major}'"
        )
    if incoming != PDV_PROTOCOL_VERSION:
        print(
            f"[PDV] version mismatch: kernel={PDV_PROTOCOL_VERSION}, app={incoming}",
            file=sys.stderr,
            flush=True,
        )


def _on_comm_message(msg: dict) -> None:
    """Handle an incoming comm message from the app.

    Parses the PDV envelope, validates the version, and dispatches to
    the appropriate handler from ``pdv_kernel.handlers``.

    Parameters
    ----------
    msg : dict
        Raw IPython comm message dict (``msg['content']['data']`` is the
        PDV envelope).
    """
    # Extract the PDV envelope from the IPython message structure
    data = msg.get("content", {}).get("data", msg)

    try:
        check_version(data)
    except PDVVersionError as exc:
        # Cannot reply (no msg_id we can trust), just log and drop
        import warnings  # noqa: PLC0415

        warnings.warn(str(exc), stacklevel=1)
        return

    from pdv_kernel.handlers import dispatch  # noqa: PLC0415

    dispatch(data)


def _on_comm_open(comm: Any, open_msg: dict) -> None:
    """Callback invoked when the app opens the ``pdv.kernel`` comm.

    Parameters
    ----------
    comm : ipykernel.comm.Comm
        The newly opened comm object.
    open_msg : dict
        The comm_open message.
    """
    global _comm
    _comm = comm
    comm.on_msg(_on_comm_message)
    # Send pdv.ready push notification now that the channel is open
    send_message("pdv.ready", {}, in_reply_to=None)


def register_comm_target(ip: Any) -> None:
    """Register the ``pdv.kernel`` comm target with IPython.

    Must be called during bootstrap. The target is registered only once
    (idempotent).

    Parameters
    ----------
    ip : InteractiveShell
        The IPython shell instance.
    """
    comm_manager = getattr(ip, "comm_manager", None)
    if comm_manager is None or not hasattr(comm_manager, "register_target"):
        kernel = getattr(ip, "kernel", None)
        comm_manager = getattr(kernel, "comm_manager", None) if kernel is not None else None
    if comm_manager is None or not hasattr(comm_manager, "register_target"):
        raise AttributeError(
            "IPython shell has no comm_manager; tried ip.comm_manager and ip.kernel.comm_manager"
        )
    comm_manager.register_target(PDV_COMM_TARGET, _on_comm_open)


def get_pdv_tree() -> Any:
    """Return the global PDVTree instance, or None if not bootstrapped.

    Returns
    -------
    PDVTree or None
        The tree instance injected into the user namespace, or None before bootstrap.
    """
    return _pdv_tree


def get_ip() -> Any:
    """Return the global IPython shell instance, or None if not bootstrapped.

    Returns
    -------
    InteractiveShell or None
        The IPython shell, or None before bootstrap.
    """
    return _ip
