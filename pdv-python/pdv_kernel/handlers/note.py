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
    from pdv_kernel.comms import send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVNote  # noqa: PLC0415
    from pdv_kernel.handlers._helpers import validate_register_request  # noqa: PLC0415

    validated = validate_register_request(msg, "pdv.note.register.response", "note")
    if validated is None:
        return
    tree, payload = validated
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    relative_path = payload.get("relative_path", "")

    note = PDVNote(relative_path=relative_path)
    full_path = f"{parent_path}.{name}" if parent_path else name
    tree[full_path] = note

    send_message(
        "pdv.note.register.response", {"path": full_path}, in_reply_to=msg.get("msg_id")
    )


register("pdv.note.register", handle_note_register)
