"""
pdv_kernel.handlers.note — Handler for PDV markdown note registration messages.

Handles:
- ``pdv.note.register``: attach a :class:`PDVNote` node to the tree
  at the specified parent path and name.

See Also
--------
PLANNED_FEATURES.md Feature 4 (Markdown Notes in the Tree)
pdv_kernel.tree.PDVNote
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_note_register(msg: dict) -> None:
    """Handle the ``pdv.note.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVNote` and attaches it to the
    tree at ``parent_path.name``. Sends a ``pdv.tree.changed`` push
    notification on success.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "notes",
            "name": "introduction",
            "relative_path": "/path/to/notes/introduction.md"
        }

    Response type: ``pdv.note.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVNote  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    relative_path = payload.get("relative_path", "")

    if not name:
        send_error(
            "pdv.note.register.response",
            "note.missing_name",
            "name is required in pdv.note.register payload",
            in_reply_to=msg_id,
        )
        return
    if not relative_path:
        send_error(
            "pdv.note.register.response",
            "note.missing_relative_path",
            "relative_path is required in pdv.note.register payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.note.register.response",
            "note.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    note = PDVNote(relative_path=relative_path)
    full_path = f"{parent_path}.{name}" if parent_path else name
    tree[full_path] = note

    send_message("pdv.note.register.response", {"path": full_path}, in_reply_to=msg_id)


register("pdv.note.register", handle_note_register)
