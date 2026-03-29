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
from pdv_kernel import log


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
    from pdv_kernel.tree import PDVTree, PDVScript, PDVNote  # noqa: PLC0415

    parts = path.split(".")
    current = tree
    for part in parts[:-1]:
        if not dict.__contains__(current, part):
            new_node: PDVTree = PDVTree()
            new_node._lazy_registry = tree._lazy_registry
            dict.__setitem__(current, part, new_node)
        current = dict.__getitem__(current, part)
    dict.__setitem__(current, parts[-1], value)


def _collect_nodes(
    tree: "Any", save_dir: str, prefix: str = "", *, working_dir: str = ""
) -> list:
    """Recursively serialize tree nodes and return descriptor list.

    Parameters
    ----------
    tree : PDVTree
        The subtree to serialize.
    save_dir : str
        The save directory to write data files to.
    prefix : str
        The dot-separated path prefix for the current subtree.
    working_dir : str
        The kernel working directory where source files live.

    Returns
    -------
    list
        List of node descriptor dicts.
    """
    from pdv_kernel.serialization import serialize_node  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

    nodes = []
    for key in dict.keys(tree):
        path = f"{prefix}.{key}" if prefix else key
        value = dict.__getitem__(tree, key)
        descriptor = serialize_node(
            path, value, save_dir, trusted=True, source_dir=working_dir or save_dir,
        )
        nodes.append(descriptor)
        if isinstance(value, PDVTree):
            nodes.extend(
                _collect_nodes(value, save_dir, prefix=path, working_dir=working_dir)
            )
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
    import sys

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree, PDVScript, PDVNote, PDVModule, PDVGui, PDVNamelist, PDVLib  # noqa: PLC0415

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

    working_dir = tree._working_dir or save_dir

    # -- Pass 1: Containers (folder, module) ----------------------------------
    # Create all container nodes first so children always have parents.
    for node in nodes:
        node_path = node.get("path", "")
        node_type = node.get("type", "")
        meta = node.get("metadata", {})

        if node_type == "folder":
            folder = PDVTree()
            folder._lazy_registry = tree._lazy_registry
            folder._working_dir = tree._working_dir
            folder._save_dir = tree._save_dir
            folder._path_prefix = node_path
            _set_tree_node(tree, node_path, folder)
        elif node_type == "module":
            # Read module metadata from metadata dict (new format) or
            # fall back to storage.value (old format)
            storage = node.get("storage", {})
            old_meta = storage.get("value", {})
            mod = PDVModule(
                module_id=meta.get("module_id", old_meta.get("module_id", "")),
                name=meta.get("name", old_meta.get("name", "")),
                version=meta.get("version", old_meta.get("version", "")),
            )
            mod._lazy_registry = tree._lazy_registry
            mod._working_dir = tree._working_dir
            mod._save_dir = tree._save_dir
            mod._path_prefix = node_path
            _set_tree_node(tree, node_path, mod)

    # -- Pass 2: Leaves (all non-container nodes) -----------------------------
    # Files are assumed to already exist in the working directory (TypeScript
    # copies them before sending pdv.project.load).
    for node in nodes:
        node_path = node.get("path", "")
        node_type = node.get("type", "")
        storage = node.get("storage", {})
        backend = storage.get("backend", "")
        meta = node.get("metadata", {})
        if node_type in ("folder", "module"):
            continue  # Already handled in pass 1

        rel_path = storage.get("relative_path", "")

        if node_type == "script":
            language = meta.get("language", node.get("language", "python"))
            doc = meta.get("doc")
            _set_tree_node(tree, node_path, PDVScript(
                relative_path=rel_path,
                language=language,
                doc=doc,
            ))
        elif node_type == "markdown":
            title = meta.get("title")
            _set_tree_node(tree, node_path, PDVNote(
                relative_path=rel_path,
                title=title,
            ))
        elif node_type == "gui":
            module_id = meta.get("module_id", node.get("module_id"))
            gui_node = PDVGui(relative_path=rel_path, module_id=module_id)
            _set_tree_node(tree, node_path, gui_node)
            # Attach gui reference to parent PDVModule if applicable
            parts = node_path.split(".")
            if len(parts) > 1:
                parent_path = ".".join(parts[:-1])
                try:
                    parent = tree[parent_path]
                    if isinstance(parent, PDVModule):
                        parent.gui = gui_node
                except Exception:  # noqa: BLE001
                    pass
        elif node_type == "namelist":
            module_id = meta.get("module_id", node.get("module_id"))
            namelist_format = meta.get("namelist_format", node.get("namelist_format", "auto"))
            _set_tree_node(tree, node_path, PDVNamelist(
                relative_path=rel_path,
                format=namelist_format,
                module_id=module_id,
            ))
        elif node_type == "lib":
            module_id = meta.get("module_id", node.get("module_id"))
            _set_tree_node(tree, node_path, PDVLib(
                relative_path=rel_path,
                module_id=module_id,
            ))
            # Add the parent directory to sys.path so the library is importable
            abs_path = os.path.join(working_dir, rel_path) if rel_path else ""
            if abs_path:
                parent_dir = os.path.dirname(abs_path)
                if parent_dir and parent_dir not in sys.path:
                    sys.path.insert(1, parent_dir)
        elif backend == "inline":
            _set_tree_node(tree, node_path, storage.get("value"))
        elif backend == "local_file":
            from pdv_kernel.serialization import deserialize_node  # noqa: PLC0415
            value = deserialize_node(storage, working_dir, trusted=True)
            _set_tree_node(tree, node_path, value)

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

    working_dir = tree._working_dir or save_dir

    try:
        nodes = _collect_nodes(tree, save_dir, working_dir=working_dir)
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
