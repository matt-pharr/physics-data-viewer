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
    from pdv_kernel.comms import send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVGui  # noqa: PLC0415
    from pdv_kernel.handlers._helpers import (  # noqa: PLC0415
        attach_gui_to_module,
        validate_register_request,
    )

    validated = validate_register_request(msg, "pdv.gui.register.response", "gui")
    if validated is None:
        return
    tree, payload = validated
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    relative_path = payload.get("relative_path", "")
    module_id = payload.get("module_id")
    source_rel_path = payload.get("source_rel_path")

    gui_node = PDVGui(
        relative_path=relative_path,
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
