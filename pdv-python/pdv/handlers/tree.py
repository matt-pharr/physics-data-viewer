"""
pdv.handlers.tree — Handlers for PDV tree query messages.

Handles:
- ``pdv.tree.list``: return the children of a tree node at a given path.
- ``pdv.tree.get``: return the value (or metadata) of a specific node.

See Also
--------
ARCHITECTURE.md §3.4 (tree messages), §7 (tree data model)
"""

from __future__ import annotations

import os

from pdv.handlers import register


def _relocate_files(
    value: object,
    old_tree_path: str,
    new_tree_path: str,
    working_dir: str,
    *,
    copy: bool = False,
) -> None:
    """Duplicate backing files for all PDVFile nodes in *value*.

    With UUID-based storage, rename/move is a no-op (the file path is
    independent of the tree path). Only ``copy=True`` (duplicate) needs
    to create a new file — the duplicate gets a fresh UUID.

    Recursively walks dicts so that container duplicates also handle
    every file-backed descendant.
    """
    from pdv.tree import PDVFile  # noqa: PLC0415

    if isinstance(value, PDVFile):
        _relocate_single_file(value, working_dir, copy=copy)
    elif isinstance(value, dict):
        for key in list(dict.keys(value)):
            child = dict.__getitem__(value, key)
            old_child = f"{old_tree_path}.{key}"
            new_child = f"{new_tree_path}.{key}"
            _relocate_files(child, old_child, new_child, working_dir,
                            copy=copy)


def _relocate_single_file(
    file_node: object,
    working_dir: str,
    *,
    copy: bool = False,
) -> None:
    """Handle file relocation for a single PDVFile node.

    With UUID-based storage, rename/move requires no file system
    operation — the backing file path is independent of the tree path.

    For duplicates (``copy=True``), a new UUID is assigned and the
    backing file is copied to the new UUID directory.
    """
    from pdv.environment import generate_node_uuid, smart_copy, uuid_tree_path  # noqa: PLC0415
    from pdv.tree import PDVFile  # noqa: PLC0415

    if not isinstance(file_node, PDVFile):
        raise TypeError(f"Expected PDVFile, got {type(file_node).__name__}")

    if not copy:
        return

    old_abs = file_node.resolve_path(working_dir)
    new_uuid = generate_node_uuid()
    new_abs = uuid_tree_path(working_dir, new_uuid, file_node.filename)
    if os.path.exists(old_abs):
        smart_copy(old_abs, new_abs)
    file_node._uuid = new_uuid


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
    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.modules import has_handler_for  # noqa: PLC0415
    from pdv.serialization import detect_kind, node_preview, python_type_string  # noqa: PLC0415
    from pdv.tree import PDVModule, PDVGui  # noqa: PLC0415

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
    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.modules import has_handler_for  # noqa: PLC0415
    from pdv.serialization import detect_kind, node_preview, python_type_string  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")
    mode = payload.get("mode", "value")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.get.response",
            "tree.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    if not path:
        send_error(
            "pdv.tree.get.response",
            "tree.missing_path",
            "path is required",
            in_reply_to=msg_id,
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

    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.tree import PDVFile  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.resolve_file.response",
            "tree.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    if not path or path not in tree:
        send_error(
            "pdv.tree.resolve_file.response",
            "tree.path_not_found",
            f"No node at path: '{path}'",
            in_reply_to=msg_id,
        )
        return

    node = tree[path]
    if not isinstance(node, PDVFile):
        send_error(
            "pdv.tree.resolve_file.response",
            "tree.not_a_file",
            f"Node at '{path}' is not file-backed",
            in_reply_to=msg_id,
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
    from pdv.comms import send_message, send_error, get_pdv_tree  # noqa: PLC0415

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


def handle_tree_create_node(msg: dict) -> None:
    """Handle ``pdv.tree.create_node`` — create an empty dict node in the tree.

    Payload
    -------
    parent_path : str
        Dot-separated path of the parent container (empty string for root).
    name : str
        Key name for the new node.
    """
    from pdv.comms import send_message, send_error, get_pdv_tree  # noqa: PLC0415
    from pdv.tree import PDVTree  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.create_node.response",
            "tree.not_initialized",
            "PDVTree is not initialized.",
            in_reply_to=msg_id,
        )
        return

    if not name:
        send_error(
            "pdv.tree.create_node.response",
            "tree.invalid_name",
            "Node name must not be empty.",
            in_reply_to=msg_id,
        )
        return

    full_path = f"{parent_path}.{name}" if parent_path else name

    if full_path in tree:
        send_error(
            "pdv.tree.create_node.response",
            "tree.already_exists",
            f"A node already exists at path: {full_path}",
            in_reply_to=msg_id,
        )
        return

    if parent_path:
        if parent_path not in tree:
            send_error(
                "pdv.tree.create_node.response",
                "tree.path_not_found",
                f"Parent path does not exist: {parent_path}",
                in_reply_to=msg_id,
            )
            return
        parent = tree[parent_path]
        if not isinstance(parent, dict):
            send_error(
                "pdv.tree.create_node.response",
                "tree.not_a_container",
                f"Parent at '{parent_path}' is not a container.",
                in_reply_to=msg_id,
            )
            return

    tree[full_path] = PDVTree()

    send_message(
        "pdv.tree.create_node.response",
        {"path": full_path, "created": True},
        in_reply_to=msg_id,
    )


def handle_tree_rename(msg: dict) -> None:
    """Handle ``pdv.tree.rename`` — change the key of a tree node.

    Moves the value from ``path`` to a sibling key ``new_name`` under the
    same parent. The old key is removed and the new key is inserted.

    Payload
    -------
    path : str
        Dot-separated path of the node to rename.
    new_name : str
        New key name (single segment, no dots).
    """
    from pdv.comms import send_message, send_error, get_pdv_tree  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")
    new_name = payload.get("new_name", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.rename.response",
            "tree.not_initialized",
            "PDVTree is not initialized.",
            in_reply_to=msg_id,
        )
        return

    if not path:
        send_error(
            "pdv.tree.rename.response",
            "tree.invalid_path",
            "Cannot rename the root tree.",
            in_reply_to=msg_id,
        )
        return

    if not new_name:
        send_error(
            "pdv.tree.rename.response",
            "tree.invalid_name",
            "New name must not be empty.",
            in_reply_to=msg_id,
        )
        return

    if "." in new_name:
        send_error(
            "pdv.tree.rename.response",
            "tree.invalid_name",
            "New name must not contain dots.",
            in_reply_to=msg_id,
        )
        return

    if path not in tree:
        send_error(
            "pdv.tree.rename.response",
            "tree.path_not_found",
            f"No node at path: {path}",
            in_reply_to=msg_id,
        )
        return

    parts = path.split(".")
    parent_path = ".".join(parts[:-1])
    new_path = f"{parent_path}.{new_name}" if parent_path else new_name

    if new_path in tree:
        send_error(
            "pdv.tree.rename.response",
            "tree.already_exists",
            f"A node already exists at path: {new_path}",
            in_reply_to=msg_id,
        )
        return

    value = tree[path]

    if tree._working_dir:
        _relocate_files(value, path, new_path, tree._working_dir, copy=False)

    tree.set_quiet(new_path, value)
    # Delete the old key at the dict level to avoid a second changed push
    if parent_path:
        parent = tree[parent_path]
        dict.__delitem__(parent, parts[-1])
    else:
        dict.__delitem__(tree, parts[-1])
    tree._emit_changed(path, "renamed")

    send_message(
        "pdv.tree.rename.response",
        {"old_path": path, "new_path": new_path, "renamed": True},
        in_reply_to=msg_id,
    )


def handle_tree_move(msg: dict) -> None:
    """Handle ``pdv.tree.move`` — move a node to a new path in the tree.

    Payload
    -------
    path : str
        Dot-separated path of the node to move.
    new_path : str
        Full dot-separated destination path.
    """
    from pdv.comms import send_message, send_error, get_pdv_tree  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")
    new_path = payload.get("new_path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.move.response",
            "tree.not_initialized",
            "PDVTree is not initialized.",
            in_reply_to=msg_id,
        )
        return

    if not path:
        send_error(
            "pdv.tree.move.response",
            "tree.invalid_path",
            "Cannot move the root tree.",
            in_reply_to=msg_id,
        )
        return

    if not new_path:
        send_error(
            "pdv.tree.move.response",
            "tree.invalid_path",
            "Destination path must not be empty.",
            in_reply_to=msg_id,
        )
        return

    if path == new_path:
        send_error(
            "pdv.tree.move.response",
            "tree.same_path",
            "Source and destination are the same.",
            in_reply_to=msg_id,
        )
        return

    if path not in tree:
        send_error(
            "pdv.tree.move.response",
            "tree.path_not_found",
            f"No node at path: {path}",
            in_reply_to=msg_id,
        )
        return

    if new_path in tree:
        send_error(
            "pdv.tree.move.response",
            "tree.already_exists",
            f"A node already exists at path: {new_path}",
            in_reply_to=msg_id,
        )
        return

    # Prevent moving a node into its own subtree
    if new_path.startswith(path + "."):
        send_error(
            "pdv.tree.move.response",
            "tree.circular_move",
            f"Cannot move '{path}' into its own subtree.",
            in_reply_to=msg_id,
        )
        return

    # Validate destination parent exists and is a container
    new_parts = new_path.split(".")
    if len(new_parts) > 1:
        dest_parent = ".".join(new_parts[:-1])
        if dest_parent not in tree:
            send_error(
                "pdv.tree.move.response",
                "tree.path_not_found",
                f"Destination parent does not exist: {dest_parent}",
                in_reply_to=msg_id,
            )
            return
        parent_val = tree[dest_parent]
        if not isinstance(parent_val, dict):
            send_error(
                "pdv.tree.move.response",
                "tree.not_a_container",
                f"Destination parent '{dest_parent}' is not a container.",
                in_reply_to=msg_id,
            )
            return

    value = tree[path]

    if tree._working_dir:
        _relocate_files(value, path, new_path, tree._working_dir,
                        copy=False)

    tree.set_quiet(new_path, value)

    old_parts = path.split(".")
    old_parent_path = ".".join(old_parts[:-1])
    if old_parent_path:
        old_parent = tree[old_parent_path]
        dict.__delitem__(old_parent, old_parts[-1])
    else:
        dict.__delitem__(tree, old_parts[-1])

    tree._emit_changed(path, "moved")

    send_message(
        "pdv.tree.move.response",
        {"old_path": path, "new_path": new_path, "moved": True},
        in_reply_to=msg_id,
    )


def handle_tree_duplicate(msg: dict) -> None:
    """Handle ``pdv.tree.duplicate`` — deep-copy a node to a new path.

    Payload
    -------
    path : str
        Dot-separated path of the node to copy.
    new_path : str
        Full dot-separated destination path for the copy.
    """
    import copy  # noqa: PLC0415

    from pdv.comms import send_message, send_error, get_pdv_tree  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")
    new_path = payload.get("new_path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.duplicate.response",
            "tree.not_initialized",
            "PDVTree is not initialized.",
            in_reply_to=msg_id,
        )
        return

    if not path:
        send_error(
            "pdv.tree.duplicate.response",
            "tree.invalid_path",
            "Cannot duplicate the root tree.",
            in_reply_to=msg_id,
        )
        return

    if not new_path:
        send_error(
            "pdv.tree.duplicate.response",
            "tree.invalid_path",
            "Destination path must not be empty.",
            in_reply_to=msg_id,
        )
        return

    if path not in tree:
        send_error(
            "pdv.tree.duplicate.response",
            "tree.path_not_found",
            f"No node at path: {path}",
            in_reply_to=msg_id,
        )
        return

    if new_path in tree:
        send_error(
            "pdv.tree.duplicate.response",
            "tree.already_exists",
            f"A node already exists at path: {new_path}",
            in_reply_to=msg_id,
        )
        return

    new_parts = new_path.split(".")
    if len(new_parts) > 1:
        dest_parent = ".".join(new_parts[:-1])
        if dest_parent not in tree:
            send_error(
                "pdv.tree.duplicate.response",
                "tree.path_not_found",
                f"Destination parent does not exist: {dest_parent}",
                in_reply_to=msg_id,
            )
            return
        parent_val = tree[dest_parent]
        if not isinstance(parent_val, dict):
            send_error(
                "pdv.tree.duplicate.response",
                "tree.not_a_container",
                f"Destination parent '{dest_parent}' is not a container.",
                in_reply_to=msg_id,
            )
            return

    value = tree[path]
    cloned = copy.deepcopy(value)

    if tree._working_dir:
        _relocate_files(cloned, path, new_path, tree._working_dir,
                        copy=True)

    tree[new_path] = cloned

    send_message(
        "pdv.tree.duplicate.response",
        {"source_path": path, "new_path": new_path, "duplicated": True},
        in_reply_to=msg_id,
    )


register("pdv.tree.list", handle_tree_list)
register("pdv.tree.get", handle_tree_get)
register("pdv.tree.resolve_file", handle_tree_resolve_file)
register("pdv.tree.delete", handle_tree_delete)
register("pdv.tree.create_node", handle_tree_create_node)
register("pdv.tree.rename", handle_tree_rename)
register("pdv.tree.move", handle_tree_move)
register("pdv.tree.duplicate", handle_tree_duplicate)
