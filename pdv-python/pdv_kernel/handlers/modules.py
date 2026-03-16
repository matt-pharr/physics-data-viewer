"""
pdv_kernel.handlers.modules — Handlers for module namespace setup and handler invocation.

Handles:
- ``pdv.modules.setup``: add module install paths to sys.path and run entry points.
- ``pdv.handler.invoke``: dispatch a registered handler for a tree node.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
pdv_kernel.modules — handler registry and decorator
"""

from __future__ import annotations

import importlib
import sys

from pdv_kernel.handlers import register


def handle_modules_setup(msg: dict) -> None:
    """Handle the ``pdv.modules.setup`` message.

    For each module in the payload, adds the install path to ``sys.path``
    (after the first entry so the current directory stays first), then
    imports the entry point module if specified.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "modules": [
                {
                    "install_path": "/path/to/module",
                    "python_package": "my_module",
                    "entry_point": "my_module.pdv_init"
                }
            ]
        }

    Response payload
    ----------------
    .. code-block:: json

        { "handlers": { "module.Class": "handler_func_name", ... } }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import send_message  # noqa: PLC0415
    from pdv_kernel.modules import get_handler_registry  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    modules = payload.get("modules", [])

    for mod_info in modules:
        install_path = mod_info.get("install_path")
        entry_point = mod_info.get("entry_point")

        if install_path and install_path not in sys.path:
            # Insert after the first entry (usually '' or cwd)
            sys.path.insert(1, install_path)

        if entry_point:
            try:
                importlib.import_module(entry_point)
            except Exception as exc:  # noqa: BLE001
                import warnings  # noqa: PLC0415

                warnings.warn(
                    f"Failed to import module entry point '{entry_point}': {exc}"
                )

    send_message(
        "pdv.modules.setup.response",
        {"handlers": get_handler_registry()},
        in_reply_to=msg_id,
    )


def handle_handler_invoke(msg: dict) -> None:
    """Handle the ``pdv.handler.invoke`` message.

    Looks up the tree node at the given path and dispatches its registered
    handler.

    Expected payload
    ----------------
    .. code-block:: json

        { "path": "data.my_obj" }

    Response payload
    ----------------
    .. code-block:: json

        { "dispatched": true }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.modules import dispatch_handler  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.handler.invoke.response",
            "tree.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    if path not in tree:
        send_error(
            "pdv.handler.invoke.response",
            "tree.path_not_found",
            f"No node at path: '{path}'",
            in_reply_to=msg_id,
        )
        return

    try:
        value = tree[path]
    except Exception as exc:
        send_error(
            "pdv.handler.invoke.response",
            "tree.load_error",
            str(exc),
            in_reply_to=msg_id,
        )
        return

    result = dispatch_handler(value, path, tree)
    send_message("pdv.handler.invoke.response", result, in_reply_to=msg_id)


register("pdv.modules.setup", handle_modules_setup)
register("pdv.handler.invoke", handle_handler_invoke)
