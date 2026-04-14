"""
pdv_kernel.handlers.tree — Handlers for PDV tree query messages.

Handles:
- ``pdv.tree.list``: return the children of a tree node at a given path.
- ``pdv.tree.get``: return the value (or metadata) of a specific node.

See Also
--------
ARCHITECTURE.md §3.4 (tree messages), §7 (tree data model)
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_tree_list(msg: dict) -> None:
    """Handle the ``pdv.tree.list`` message.

    Returns the children of the tree node at the given path as an array
    of node descriptor dicts.

    Expected payload
    ----------------
    .. code-block:: json

        { "path": "data.waveforms" }

    An empty ``path`` (or ``""``) returns the top-level children of the
    tree root.

    Response payload
    ----------------
    .. code-block:: json

        { "nodes": [ <node-descriptor>, ... ] }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.modules import has_handler_for  # noqa: PLC0415
    from pdv_kernel.serialization import detect_kind, node_preview, python_type_string  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree, PDVModule, PDVGui  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    path = msg.get("payload", {}).get("path", "")
    tree = get_pdv_tree()

    if tree is None:
        send_error(
            "pdv.tree.list.response",
            "tree.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    # Get the container at the given path (or the root tree itself)
    if path:
        try:
            container = tree[path]
        except Exception:
            send_error(
                "pdv.tree.list.response",
                "tree.path_not_found",
                f"No node at path: '{path}'",
                in_reply_to=msg_id,
            )
            return
        if not isinstance(container, dict):
            send_error(
                "pdv.tree.list.response",
                "tree.not_a_folder",
                f"Node at '{path}' is not a folder",
                in_reply_to=msg_id,
            )
            return
    else:
        container = tree

    nodes = []
    for key in list(dict.keys(container)):
        try:
            value = dict.__getitem__(container, key)
        except KeyError:
            continue  # key deleted concurrently by another thread
        child_path = f"{path}.{key}" if path else key
        kind = detect_kind(value)
        preview = node_preview(value, kind)
        has_children = isinstance(value, dict) and bool(dict.keys(value))
        descriptor = {
            "id": child_path,
            "path": child_path,
            "key": key,
            "parent_path": path,
            "type": kind,
            "has_children": has_children,
            "preview": preview,
            "python_type": python_type_string(value),
            "has_handler": has_handler_for(value),
        }
        if kind == "module" and isinstance(value, PDVModule):
            descriptor["module_id"] = value.module_id
            descriptor["module_name"] = value.name
            descriptor["module_version"] = value.version
            if getattr(value, "description", ""):
                descriptor["module_description"] = value.description
            if getattr(value, "language", ""):
                descriptor["module_language"] = value.language
        if kind == "gui" and isinstance(value, PDVGui):
            descriptor["module_id"] = value.module_id
        nodes.append(descriptor)

    send_message("pdv.tree.list.response", {"nodes": nodes}, in_reply_to=msg_id)


def handle_tree_get(msg: dict) -> None:
    """Handle the ``pdv.tree.get`` message.

    Returns the value or metadata for a specific tree node.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "path": "data.waveforms.ch1",
            "mode": "value"
        }

    ``mode`` is one of ``'metadata'``, ``'preview'``, ``'value'``,
    ``'slice'`` (see ARCHITECTURE.md §7).

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.modules import has_handler_for  # noqa: PLC0415
    from pdv_kernel.serialization import detect_kind, node_preview, python_type_string  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")
    mode = payload.get("mode", "value")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.get.response", "tree.no_tree", "PDVTree is not initialized", in_reply_to=msg_id
        )
        return

    if not path:
        send_error(
            "pdv.tree.get.response", "tree.missing_path", "path is required", in_reply_to=msg_id
        )
        return

    if path not in tree:
        send_error(
            "pdv.tree.get.response",
            "tree.path_not_found",
            f"No node at path: '{path}'",
            in_reply_to=msg_id,
        )
        return

    if mode == "metadata":
        value = tree[path]
        kind = detect_kind(value)
        send_message(
            "pdv.tree.get.response",
            {"path": path, "type": kind, "storage": {}},
            in_reply_to=msg_id,
        )
        return

    # mode == 'value' or 'preview': load value
    try:
        value = tree[path]
    except Exception as exc:
        send_error(
            "pdv.tree.get.response", "tree.load_error", str(exc), in_reply_to=msg_id
        )
        return

    kind = detect_kind(value)
    preview = node_preview(value, kind)
    send_message(
        "pdv.tree.get.response",
        {
            "path": path,
            "type": kind,
            "preview": preview,
            "value": repr(value),
            "python_type": python_type_string(value),
            "has_handler": has_handler_for(value),
        },
        in_reply_to=msg_id,
    )


def handle_tree_resolve_file(msg: dict) -> None:
    """Handle the ``pdv.tree.resolve_file`` message.

    Returns the absolute file path for a file-backed tree node (PDVFile
    subclass: PDVScript, PDVLib, PDVNamelist, PDVNote, etc.).

    Expected payload
    ----------------
    .. code-block:: json

        { "path": "n_pendulum.lib.n_pendulum_py" }

    Response payload
    ----------------
    .. code-block:: json

        { "path": "n_pendulum.lib.n_pendulum_py", "file_path": "/abs/path/to/n_pendulum.py" }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import os  # noqa: PLC0415

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVFile  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.resolve_file.response", "tree.no_tree",
            "PDVTree is not initialized", in_reply_to=msg_id,
        )
        return

    if not path or path not in tree:
        send_error(
            "pdv.tree.resolve_file.response", "tree.path_not_found",
            f"No node at path: '{path}'", in_reply_to=msg_id,
        )
        return

    node = tree[path]
    if not isinstance(node, PDVFile):
        send_error(
            "pdv.tree.resolve_file.response", "tree.not_a_file",
            f"Node at '{path}' is not file-backed", in_reply_to=msg_id,
        )
        return

    abs_path = node.resolve_path(tree._working_dir)

    send_message(
        "pdv.tree.resolve_file.response",
        {"path": path, "file_path": abs_path},
        in_reply_to=msg_id,
    )


def handle_tree_delete(msg: dict) -> None:
    """Handle ``pdv.tree.delete`` — remove a node from the tree by path.

    Payload
    -------
    path : str
        Dot-separated tree path of the node to delete.
    """
    from pdv_kernel.comms import send_message, send_error, get_pdv_tree  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.delete.response",
            "tree.not_initialized",
            "PDVTree is not initialized.",
            in_reply_to=msg_id,
        )
        return

    if not path:
        send_error(
            "pdv.tree.delete.response",
            "tree.invalid_path",
            "Cannot delete the root tree.",
            in_reply_to=msg_id,
        )
        return

    try:
        del tree[path]
    except KeyError:
        send_error(
            "pdv.tree.delete.response",
            "tree.path_not_found",
            f"No node exists at path: {path}",
            in_reply_to=msg_id,
        )
        return

    send_message(
        "pdv.tree.delete.response",
        {"path": path, "deleted": True},
        in_reply_to=msg_id,
    )


register("pdv.tree.list", handle_tree_list)
register("pdv.tree.get", handle_tree_get)
register("pdv.tree.resolve_file", handle_tree_resolve_file)
register("pdv.tree.delete", handle_tree_delete)
