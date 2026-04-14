"""
pdv_kernel.handlers.namelist — Handlers for PDV namelist messages.

Handles:
- ``pdv.namelist.read``: parse a namelist file and return structured data.
- ``pdv.namelist.write``: write structured data back to a namelist file.
- ``pdv.file.register``: register a file-backed tree node (namelist, etc.).

See Also
--------
pdv_kernel.namelist_utils
pdv_kernel.tree.PDVNamelist
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_namelist_read(msg: dict) -> None:
    """Handle the ``pdv.namelist.read`` message.

    Resolves a PDVNamelist from the tree, parses the backing file, and
    returns structured data with comment hints and inferred types.

    Expected payload
    ----------------
    .. code-block:: json

        { "tree_path": "module.solver_nml" }

    Response type: ``pdv.namelist.read.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import send_error, send_message  # noqa: PLC0415
    from pdv_kernel.handlers._helpers import resolve_namelist_node  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    resolved = resolve_namelist_node(msg, "pdv.namelist.read.response")
    if resolved is None:
        return
    _tree, node, file_path, _payload = resolved

    try:
        from pdv_kernel.namelist_utils import (  # noqa: PLC0415
            extract_hints,
            infer_types,
            read_namelist,
        )

        fmt = node.format
        groups = read_namelist(file_path, format=fmt)
        hints = extract_hints(file_path, format=fmt)
        types = infer_types(groups)
        # Determine effective format (resolve "auto")
        if fmt == "auto":
            from pdv_kernel.namelist_utils import detect_namelist_format  # noqa: PLC0415
            fmt = detect_namelist_format(file_path)
    except ImportError as exc:
        send_error(
            "pdv.namelist.read.response",
            "namelist.import_error",
            str(exc),
            in_reply_to=msg_id,
        )
        return
    except Exception as exc:  # noqa: BLE001
        send_error(
            "pdv.namelist.read.response",
            "namelist.read_error",
            f"Failed to read namelist: {exc}",
            in_reply_to=msg_id,
        )
        return

    send_message(
        "pdv.namelist.read.response",
        {
            "groups": groups,
            "hints": hints,
            "types": types,
            "format": fmt,
        },
        in_reply_to=msg_id,
    )


def handle_namelist_write(msg: dict) -> None:
    """Handle the ``pdv.namelist.write`` message.

    Resolves a PDVNamelist from the tree and writes the provided data
    back to the backing file.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "tree_path": "module.solver_nml",
            "data": { "group": { "key": "value" } }
        }

    Response type: ``pdv.namelist.write.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import send_error, send_message  # noqa: PLC0415
    from pdv_kernel.handlers._helpers import resolve_namelist_node  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    resolved = resolve_namelist_node(msg, "pdv.namelist.write.response")
    if resolved is None:
        return
    _tree, node, file_path, payload = resolved
    data = payload.get("data", {})

    try:
        from pdv_kernel.namelist_utils import write_namelist  # noqa: PLC0415

        write_namelist(file_path, data, format=node.format)
    except ImportError as exc:
        send_error(
            "pdv.namelist.write.response",
            "namelist.import_error",
            str(exc),
            in_reply_to=msg_id,
        )
        return
    except Exception as exc:  # noqa: BLE001
        send_error(
            "pdv.namelist.write.response",
            "namelist.write_error",
            f"Failed to write namelist: {exc}",
            in_reply_to=msg_id,
        )
        return

    send_message(
        "pdv.namelist.write.response",
        {"success": True},
        in_reply_to=msg_id,
    )


def handle_file_register(msg: dict) -> None:
    """Handle the ``pdv.file.register`` message.

    Creates a file-backed tree node (PDVNamelist, or generic PDVFile)
    at the specified parent path.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "tree_path": "n_pendulum",
            "filename": "solver.nml",
            "node_type": "namelist"
        }

    Response type: ``pdv.file.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import os  # noqa: PLC0415

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVFile, PDVLib, PDVNamelist  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    tree_path = payload.get("tree_path", "")
    filename = payload.get("filename", "")
    node_type = payload.get("node_type", "file")
    explicit_name = payload.get("name", "")
    module_id = payload.get("module_id")
    source_rel_path = payload.get("source_rel_path")

    if not filename:
        send_error(
            "pdv.file.register.response",
            "file.missing_filename",
            "filename is required in pdv.file.register payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.file.register.response",
            "file.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    # Build relative path: the file is expected under
    # ``<working_dir>/tree/<tree_path_segments>/<filename>``.
    # The ``tree/`` prefix is the canonical working-dir/save-dir subdir
    # for every file-backed tree node (ARCHITECTURE.md §6.1/§6.2) —
    # ``serialize_node`` writes into it and ``copyFilesForLoad`` mirrors
    # from it, so keeping the in-memory rel-path prefixed here ensures
    # the value stays stable across save/load cycles. See the #140 PR's
    # Option-A canonical-layout fix.
    segments = tree_path.split(".") if tree_path else []
    relative_path = os.path.join("tree", *segments, filename)

    # Use explicit name if provided, otherwise derive from filename stem
    if explicit_name:
        node_name = explicit_name
    else:
        node_name = os.path.splitext(filename)[0]
        # Handle double extensions like .gui.json
        while "." in node_name:
            node_name = os.path.splitext(node_name)[0]
    # Sanitize: replace characters invalid in tree paths
    node_name = node_name.replace("-", "_").replace(" ", "_")

    full_path = f"{tree_path}.{node_name}" if tree_path else node_name

    if node_type == "namelist":
        node = PDVNamelist(
            relative_path=relative_path,
            format="auto",
            module_id=module_id,
            source_rel_path=source_rel_path,
        )
    elif node_type == "lib":
        node = PDVLib(
            relative_path=relative_path,
            module_id=module_id,
            source_rel_path=source_rel_path,
        )
    else:
        node = PDVFile(
            relative_path=relative_path,
            source_rel_path=source_rel_path,
        )

    tree[full_path] = node

    send_message(
        "pdv.file.register.response",
        {"path": full_path},
        in_reply_to=msg_id,
    )


register("pdv.namelist.read", handle_namelist_read)
register("pdv.namelist.write", handle_namelist_write)
register("pdv.file.register", handle_file_register)
