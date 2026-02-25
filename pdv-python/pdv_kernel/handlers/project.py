"""
pdv_kernel.handlers.project — Handlers for PDV project messages.

Handles:
- ``pdv.project.load``: load a project from a save directory. Reads
  ``tree-index.json``, populates the lazy-load registry, rebuilds the
  in-memory tree structure, sends ``pdv.project.loaded`` push.
- ``pdv.project.save``: serialize the current tree to a save directory.
  Sends ``pdv.project.save.response`` with node count and checksum.

See Also
--------
ARCHITECTURE.md §4.2 (project load sequence), §8 (save and load)
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def _set_tree_node(tree: "Any", path: str, value: "Any") -> None:
    """Set a value at a dot-path in the tree bypassing notifications.

    Creates intermediate PDVTree nodes as needed without triggering
    push notifications (used during bulk project load).

    Parameters
    ----------
    tree : PDVTree
        The root tree to set the value in.
    path : str
        Dot-separated path to the target node.
    value : Any
        The value to set at the path.
    """
    from pdv_kernel.tree import PDVTree, PDVScript  # noqa: PLC0415

    parts = path.split(".")
    current = tree
    for part in parts[:-1]:
        if not dict.__contains__(current, part):
            new_node: PDVTree = PDVTree()
            new_node._lazy_registry = tree._lazy_registry
            dict.__setitem__(current, part, new_node)
        current = dict.__getitem__(current, part)
    dict.__setitem__(current, parts[-1], value)


def _collect_nodes(tree: "Any", save_dir: str, prefix: str = "") -> list:
    """Recursively serialize tree nodes and return descriptor list.

    Parameters
    ----------
    tree : PDVTree
        The subtree to serialize.
    save_dir : str
        The save directory to write data files to.
    prefix : str
        The dot-separated path prefix for the current subtree.

    Returns
    -------
    list
        List of node descriptor dicts.
    """
    from pdv_kernel.serialization import serialize_node  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree, PDVScript  # noqa: PLC0415

    nodes = []
    for key in dict.keys(tree):
        path = f"{prefix}.{key}" if prefix else key
        value = dict.__getitem__(tree, key)
        descriptor = serialize_node(path, value, save_dir)
        nodes.append(descriptor)
        if isinstance(value, PDVTree):
            nodes.extend(_collect_nodes(value, save_dir, prefix=path))
    return nodes



def handle_project_load(msg: dict) -> None:
    """Handle the ``pdv.project.load`` message.

    Loads a project from a save directory. After this handler completes,
    the kernel sends a ``pdv.project.loaded`` push notification (no
    ``in_reply_to``).

    Expected payload
    ----------------
    .. code-block:: json

        { "save_dir": "/path/to/project" }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import json
    import os
    import shutil

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree, PDVScript  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    save_dir = payload.get("save_dir", "")

    if not save_dir or not os.path.isdir(save_dir):
        send_error(
            "pdv.project.load.response",
            "project.invalid_save_dir",
            f"save_dir does not exist or is not a directory: '{save_dir}'",
            in_reply_to=msg_id,
        )
        return

    tree_index_path = os.path.join(save_dir, "tree-index.json")
    if not os.path.exists(tree_index_path):
        send_error(
            "pdv.project.load.response",
            "project.missing_tree_index",
            f"tree-index.json not found in save directory: '{save_dir}'",
            in_reply_to=msg_id,
        )
        return

    try:
        with open(tree_index_path, "r", encoding="utf-8") as fh:
            nodes = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        send_error(
            "pdv.project.load.response",
            "project.corrupt_tree_index",
            f"Failed to parse tree-index.json: {exc}",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.project.load.response",
            "project.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    # Clear existing in-memory tree and registry
    for k in list(dict.keys(tree)):
        dict.__delitem__(tree, k)
    tree._lazy_registry.clear()
    tree._set_save_dir(save_dir)

    # Process node descriptors: build folder skeleton and register lazy entries
    for node in nodes:
        path = node.get("path", "")
        node_type = node.get("type", "")
        storage = node.get("storage", {})
        backend = storage.get("backend", "")

        if node_type == "folder":
            _set_tree_node(tree, path, PDVTree())
        elif node_type == "script":
            relative_path = storage.get("relative_path", "")
            source_path = os.path.join(save_dir, relative_path) if relative_path else storage.get("value", "")
            if source_path and not os.path.isabs(source_path):
                source_path = os.path.join(save_dir, source_path)
            if not source_path or not os.path.exists(source_path):
                send_error(
                    "pdv.project.load.response",
                    "project.missing_script_file",
                    f"Script file not found for '{path}'",
                    in_reply_to=msg_id,
                )
                return
            target_relative = relative_path or os.path.join("tree", *path.split(".")) + ".py"
            working_dir = tree._working_dir or save_dir
            target_path = os.path.join(working_dir, target_relative)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            if os.path.abspath(source_path) != os.path.abspath(target_path):
                shutil.copy2(source_path, target_path)
            language = node.get("language", "python")
            _set_tree_node(tree, path, PDVScript(relative_path=target_path, language=language))
        elif backend == "inline":
            _set_tree_node(tree, path, storage.get("value"))
        elif node.get("lazy", False):
            # Will be fetched on demand
            tree._lazy_registry.register(path, storage)
        else:
            # Non-lazy file-backed node — register for lazy loading anyway
            tree._lazy_registry.register(path, storage)

    node_count = len(nodes)
    send_message(
        "pdv.project.load.response",
        {"node_count": node_count},
        in_reply_to=msg_id,
    )
    # Send pdv.project.loaded push notification (no in_reply_to)
    send_message(
        "pdv.project.loaded",
        {"node_count": node_count, "project_name": "", "saved_at": ""},
    )


def handle_project_save(msg: dict) -> None:
    """Handle the ``pdv.project.save`` message.

    Serializes the entire tree to the save directory. Writes data files
    and ``tree-index.json``. Sends ``pdv.project.save.response`` with
    a node count and checksum of ``tree-index.json``.

    Expected payload
    ----------------
    .. code-block:: json

        { "save_dir": "/path/to/project" }

    Response payload
    ----------------
    .. code-block:: json

        { "node_count": 42, "checksum": "<sha256-of-tree-index.json>" }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import hashlib
    import json
    import os

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    save_dir = payload.get("save_dir", "")

    if not save_dir:
        send_error(
            "pdv.project.save.response",
            "project.missing_save_dir",
            "save_dir is required in the pdv.project.save payload",
            in_reply_to=msg_id,
        )
        return

    os.makedirs(os.path.join(save_dir, "tree"), exist_ok=True)

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.project.save.response",
            "project.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    try:
        nodes = _collect_nodes(tree, save_dir)
    except Exception as exc:  # noqa: BLE001
        send_error(
            "pdv.project.save.response",
            "project.serialization_error",
            str(exc),
            in_reply_to=msg_id,
        )
        return

    index_data = json.dumps(nodes, indent=2, default=str)
    index_path = os.path.join(save_dir, "tree-index.json")
    with open(index_path, "w", encoding="utf-8") as fh:
        fh.write(index_data)

    checksum = hashlib.sha256(index_data.encode("utf-8")).hexdigest()

    send_message(
        "pdv.project.save.response",
        {"node_count": len(nodes), "checksum": checksum},
        in_reply_to=msg_id,
    )


register("pdv.project.load", handle_project_load)
register("pdv.project.save", handle_project_save)
