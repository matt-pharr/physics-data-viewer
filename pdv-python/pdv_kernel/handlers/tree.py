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
    from pdv_kernel.serialization import detect_kind, node_preview  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

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
    for key in dict.keys(container):
        value = dict.__getitem__(container, key)
        child_path = f"{path}.{key}" if path else key
        kind = detect_kind(value)
        preview = node_preview(value, kind)
        has_children = isinstance(value, dict) and bool(dict.keys(value))
        lazy = tree._lazy_registry.has(child_path)
        descriptor = {
            "id": child_path,
            "path": child_path,
            "key": key,
            "parent_path": path,
            "type": kind,
            "has_children": has_children,
            "lazy": lazy,
            "preview": preview,
        }
        if kind == "script":
            descriptor["params"] = getattr(value, "params", [])
        nodes.append(descriptor)

    # Also include lazy-only entries at this path level that are not yet in memory
    for reg_path in list(tree._lazy_registry._registry.keys()):
        parts = reg_path.split(".")
        parent = ".".join(parts[:-1])
        if parent == path:
            key = parts[-1]
            if not dict.__contains__(container, key):
                storage = tree._lazy_registry._registry[reg_path]
                nodes.append(
                    {
                        "id": reg_path,
                        "path": reg_path,
                        "key": key,
                        "parent_path": path,
                        "type": storage.get("format", "unknown"),
                        "has_children": False,
                        "lazy": True,
                        "preview": "<lazy>",
                    }
                )

    send_message("pdv.tree.list.response", {"nodes": nodes}, in_reply_to=msg_id)


def handle_tree_get(msg: dict) -> None:
    """Handle the ``pdv.tree.get`` message.

    Returns the value or metadata for a specific tree node. If the node
    is lazy, this triggers a transparent load from the save directory.

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
    from pdv_kernel.serialization import detect_kind, node_preview  # noqa: PLC0415

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
        # Return descriptor without loading lazy data from disk
        lazy = tree._lazy_registry.has(path)
        storage = tree._lazy_registry._registry.get(path, {}) if lazy else {}
        send_message(
            "pdv.tree.get.response",
            {"path": path, "lazy": lazy, "type": storage.get("format", "unknown"), "storage": storage},
            in_reply_to=msg_id,
        )
        return

    # mode == 'value' or 'preview': load value (triggers lazy fetch if needed)
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
        {"path": path, "type": kind, "preview": preview, "value": repr(value)},
        in_reply_to=msg_id,
    )


register("pdv.tree.list", handle_tree_list)
register("pdv.tree.get", handle_tree_get)
