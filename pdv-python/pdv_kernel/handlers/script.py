"""
pdv_kernel.handlers.script — Handler for PDV script registration messages.

Handles:
- ``pdv.script.register``: attach a :class:`PDVScript` node to the tree
  at the specified parent path and name.

See Also
--------
ARCHITECTURE.md §3.4 (script messages)
pdv_kernel.tree.PDVScript
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_script_register(msg: dict) -> None:
    """Handle the ``pdv.script.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVScript` and attaches it to the
    tree at ``parent_path.name``. Sends a ``pdv.tree.changed`` push
    notification on success.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "scripts.analysis",
            "name": "fit_model",
            "relative_path": "tree/scripts/analysis/fit_model.py",
            "language": "python"
        }

    Response type: ``pdv.script.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVScript  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    relative_path = payload.get("relative_path", "")
    language = payload.get("language", "python")

    if not name:
        send_error(
            "pdv.script.register.response",
            "script.missing_name",
            "name is required in pdv.script.register payload",
            in_reply_to=msg_id,
        )
        return
    if not relative_path:
        send_error(
            "pdv.script.register.response",
            "script.missing_relative_path",
            "relative_path is required in pdv.script.register payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.script.register.response",
            "script.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    script = PDVScript(relative_path=relative_path, language=language)
    full_path = f"{parent_path}.{name}" if parent_path else name
    tree[full_path] = script

    send_message("pdv.script.register.response", {"path": full_path}, in_reply_to=msg_id)


register("pdv.script.register", handle_script_register)
