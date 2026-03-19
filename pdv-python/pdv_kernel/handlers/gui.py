"""
pdv_kernel.handlers.gui — Handler for PDV GUI registration messages.

Handles:
- ``pdv.gui.register``: attach a :class:`PDVGui` node to the tree
  at the specified parent path and name.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
pdv_kernel.tree.PDVGui
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_gui_register(msg: dict) -> None:
    """Handle the ``pdv.gui.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVGui` and attaches it to the
    tree. If the parent is a :class:`~pdv_kernel.tree.PDVModule`, also
    sets the module's ``.gui`` attribute.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "n_pendulum",
            "name": "gui",
            "relative_path": "tree/n_pendulum/gui.gui.json",
            "module_id": "n_pendulum"
        }

    Response type: ``pdv.gui.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVGui, PDVModule  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    relative_path = payload.get("relative_path", "")
    module_id = payload.get("module_id")

    if not name:
        send_error(
            "pdv.gui.register.response",
            "gui.missing_name",
            "name is required in pdv.gui.register payload",
            in_reply_to=msg_id,
        )
        return
    if not relative_path:
        send_error(
            "pdv.gui.register.response",
            "gui.missing_relative_path",
            "relative_path is required in pdv.gui.register payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.gui.register.response",
            "gui.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    gui_node = PDVGui(relative_path=relative_path, module_id=module_id)
    full_path = f"{parent_path}.{name}" if parent_path else name
    tree[full_path] = gui_node

    # If the parent is a PDVModule, attach the gui reference
    if parent_path:
        try:
            parent = tree[parent_path]
            if isinstance(parent, PDVModule):
                parent.gui = gui_node
        except Exception:  # noqa: BLE001
            pass

    send_message(
        "pdv.gui.register.response",
        {"path": full_path},
        in_reply_to=msg_id,
    )


register("pdv.gui.register", handle_gui_register)
