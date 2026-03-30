"""
pdv_kernel.handlers.namespace — Handler for PDV namespace query messages.

Handles:
- ``pdv.namespace.query``: return a snapshot of the kernel user
  namespace for the Namespace panel.
- ``pdv.namespace.inspect``: lazily inspect one namespace value and
  return a single level of children.

See Also
--------
ARCHITECTURE.md §3.4 (namespace messages)
pdv_kernel.namespace.pdv_namespace
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_namespace_query(msg: dict) -> None:
    """Handle the ``pdv.namespace.query`` message.

    Returns a snapshot of the current kernel user namespace.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "include_private": false,
            "include_modules": false,
            "include_callables": false
        }

    All fields are optional and default to ``false``.

    Response payload
    ----------------
    .. code-block:: json

        { "variables": { "<name>": <descriptor>, ... } }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_ip, send_message  # noqa: PLC0415
    from pdv_kernel.namespace import pdv_namespace  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    include_private = payload.get("include_private", False)
    include_modules = payload.get("include_modules", False)
    include_callables = payload.get("include_callables", False)

    ip = get_ip()
    ns = ip.user_ns if ip is not None else {}

    variables = pdv_namespace(
        ns,
        include_private=include_private,
        include_modules=include_modules,
        include_callables=include_callables,
    )

    send_message("pdv.namespace.query.response", {"variables": variables}, in_reply_to=msg_id)


def handle_namespace_inspect(msg: dict) -> None:
    """Handle the ``pdv.namespace.inspect`` message."""
    from pdv_kernel.comms import get_ip, send_message  # noqa: PLC0415
    from pdv_kernel.namespace import inspect_namespace  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    root_name = payload.get("root_name", "")
    path = payload.get("path", [])

    ip = get_ip()
    ns = ip.user_ns if ip is not None else {}

    try:
        response_payload = inspect_namespace(
            ns,
            root_name=root_name,
            path=path,
        )
    except Exception as exc:  # noqa: BLE001
        send_message(
            "pdv.namespace.inspect.response",
            {"error": str(exc), "children": [], "truncated": False},
            in_reply_to=msg_id,
        )
        return

    send_message("pdv.namespace.inspect.response", response_payload, in_reply_to=msg_id)


register("pdv.namespace.query", handle_namespace_query)
register("pdv.namespace.inspect", handle_namespace_inspect)
