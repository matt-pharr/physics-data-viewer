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


def handle_module_register(msg: dict) -> None:
    """Handle the ``pdv.module.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVModule` and attaches it to the
    tree at the given alias path.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "path": "n_pendulum",
            "module_id": "n_pendulum",
            "name": "N-Pendulum",
            "version": "2.0.0"
        }

    Response type: ``pdv.module.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVModule  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")
    module_id = payload.get("module_id", "")
    name = payload.get("name", "")
    version = payload.get("version", "")

    if not path or not module_id:
        send_error(
            "pdv.module.register.response",
            "module.missing_fields",
            "path and module_id are required in pdv.module.register payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.module.register.response",
            "module.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    module_node = PDVModule(module_id=module_id, name=name, version=version)
    tree[path] = module_node

    send_message(
        "pdv.module.register.response",
        {"path": path, "module_id": module_id},
        in_reply_to=msg_id,
    )


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


register("pdv.module.register", handle_module_register)
register("pdv.modules.setup", handle_modules_setup)
register("pdv.handler.invoke", handle_handler_invoke)
