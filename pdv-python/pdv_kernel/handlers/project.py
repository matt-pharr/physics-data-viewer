"""
pdv_kernel.handlers.project — Handlers for PDV project messages.

Handles:
- ``pdv.project.load``: load a project from a save directory. Reads
  ``tree-index.json``, rebuilds the in-memory tree structure, sends
  ``pdv.project.loaded`` push.
- ``pdv.project.save``: serialize the current tree to a save directory.
  Sends ``pdv.project.save.response`` with node count and checksum.

See Also
--------
ARCHITECTURE.md §4.2 (project load sequence), §8 (save and load)
"""

from __future__ import annotations

from pdv_kernel.handlers import register
from pdv_kernel import log


def _count_nodes(tree: "Any") -> int:
    """Count total nodes in a tree recursively (no I/O)."""
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

    count = 0
    for key in dict.keys(tree):
        count += 1
        value = dict.__getitem__(tree, key)
        if isinstance(value, PDVTree):
            count += _count_nodes(value)
    return count


def _collect_nodes(
    tree: "Any",
    save_dir: str,
    prefix: str = "",
    *,
    working_dir: str = "",
    on_progress: "Callable[[int], None] | None" = None,
    counter: "list[int] | None" = None,
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
    on_progress : callable, optional
        Called with current node count after each node is serialized.
    counter : list, optional
        Mutable single-element list tracking the running count across recursion.

    Returns
    -------
    list
        List of node descriptor dicts.
    """
    from pdv_kernel.serialization import serialize_node  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

    if counter is None:
        counter = [0]

    nodes = []
    for key in dict.keys(tree):
        path = f"{prefix}.{key}" if prefix else key
        value = dict.__getitem__(tree, key)
        descriptor = serialize_node(
            path, value, save_dir, trusted=True, source_dir=working_dir or save_dir,
        )
        nodes.append(descriptor)
        counter[0] += 1
        if on_progress is not None:
            on_progress(counter[0])
        if isinstance(value, PDVTree):
            nodes.extend(
                _collect_nodes(
                    value, save_dir, prefix=path, working_dir=working_dir,
                    on_progress=on_progress, counter=counter,
                )
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

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

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

    # Clear existing in-memory tree
    for k in list(dict.keys(tree)):
        dict.__delitem__(tree, k)
    tree._set_save_dir(save_dir)

    working_dir = tree._working_dir or save_dir

    from pdv_kernel.tree_loader import load_tree_index  # noqa: PLC0415

    def _emit_load_progress(current: int, total: int) -> None:
        if current % 5 == 0 or current == total:
            send_message("pdv.progress", {
                "operation": "load",
                "phase": "Rebuilding tree",
                "current": current,
                "total": total,
            })

    load_tree_index(
        tree,
        nodes,
        on_progress=_emit_load_progress,
        conflict_strategy="replace",
        working_dir=working_dir,
        inject_lib_sys_path=True,
    )

    os.chdir(os.path.expanduser("~"))
    node_count = len(nodes)

    from pdv_kernel.checksum import tree_checksum  # noqa: PLC0415
    post_load_checksum = tree_checksum(tree)

    send_message(
        "pdv.project.load.response",
        {"node_count": node_count, "post_load_checksum": post_load_checksum},
        in_reply_to=msg_id,
    )
    # Send pdv.project.loaded push notification (no in_reply_to)
    send_message(
        "pdv.project.loaded",
        {"node_count": node_count},
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

    total = _count_nodes(tree)

    def _emit_save_progress(current: int) -> None:
        if current % 5 == 0 or current == total:
            send_message("pdv.progress", {
                "operation": "save",
                "phase": "Serializing",
                "current": current,
                "total": total,
            })

    try:
        nodes = _collect_nodes(
            tree, save_dir, working_dir=working_dir,
            on_progress=_emit_save_progress,
        )
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
    tmp_path = index_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(index_data)
    os.replace(tmp_path, index_path)

    from pdv_kernel.checksum import tree_checksum  # noqa: PLC0415
    checksum = tree_checksum(tree)

    send_message(
        "pdv.project.save.response",
        {"node_count": len(nodes), "checksum": checksum},
        in_reply_to=msg_id,
    )


register("pdv.project.load", handle_project_load)
register("pdv.project.save", handle_project_save)
