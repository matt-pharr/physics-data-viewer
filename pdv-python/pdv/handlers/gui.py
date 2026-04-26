"""
pdv.handlers.gui — Handler for PDV GUI registration messages.

Handles:
- ``pdv.gui.register``: attach a :class:`PDVGui` node to the tree
  at the specified parent path and name.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
pdv.tree.PDVGui
"""

from __future__ import annotations

from pdv.handlers import register


def handle_gui_register(msg: dict) -> None:
    """Handle the ``pdv.gui.register`` message.

    Creates a :class:`~pdv.tree.PDVGui` and attaches it to the
    tree. If the parent is a :class:`~pdv.tree.PDVModule`, also
    sets the module's ``.gui`` attribute.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "n_pendulum",
            "name": "gui",
            "uuid": "a1b2c3d4e5f6",
            "filename": "gui.gui.json",
            "module_id": "n_pendulum"
        }

    Response type: ``pdv.gui.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv.comms import send_message  # noqa: PLC0415
    from pdv.tree import PDVGui  # noqa: PLC0415
    from pdv.handlers._helpers import (  # noqa: PLC0415
        attach_gui_to_module,
        validate_register_request,
    )

    validated = validate_register_request(msg, "pdv.gui.register.response", "gui")
    if validated is None:
        return
    tree, payload = validated
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    node_uuid = payload.get("uuid", "")
    filename = payload.get("filename", "")
    module_id = payload.get("module_id")
    source_rel_path = payload.get("source_rel_path")

    gui_node = PDVGui(
        uuid=node_uuid,
        filename=filename,
        module_id=module_id,
        source_rel_path=source_rel_path,
    )
    full_path = f"{parent_path}.{name}" if parent_path else name
    tree[full_path] = gui_node
    attach_gui_to_module(tree, parent_path, gui_node)

    send_message(
        "pdv.gui.register.response",
        {"path": full_path},
        in_reply_to=msg.get("msg_id"),
    )


register("pdv.gui.register", handle_gui_register)
