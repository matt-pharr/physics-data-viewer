"""
pdv.handlers._helpers — Shared validation and lookup helpers.

Small utilities used by multiple handler modules to remove repetitive
validation boilerplate. None of these helpers are part of the PDV public
API; they exist purely to keep individual handlers focused on their
domain logic.
"""

from __future__ import annotations

from typing import Any


def validate_register_request(
    msg: dict,
    response_type: str,
    code_prefix: str,
    required_fields: tuple[str, ...] = ("name", "uuid", "filename"),
) -> tuple[Any, dict] | None:
    """Validate a ``pdv.<thing>.register`` request and resolve the tree.

    Replaces the ~25 lines of identical "missing field / no tree"
    boilerplate that previously appeared in every register handler.

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    response_type : str
        The full ``pdv.<thing>.register.response`` type string used when
        sending validation errors.
    code_prefix : str
        Error-code namespace prefix, e.g. ``"script"`` or ``"gui"``.
        Errors are emitted as ``f"{code_prefix}.missing_{field}"`` and
        ``f"{code_prefix}.no_tree"``.
    required_fields : tuple of str, optional
        Payload fields that must be present and truthy. Defaults to
        ``("name", "uuid", "filename")``.

    Returns
    -------
    tuple[PDVTree, dict] or None
        ``(tree, payload)`` on success, or ``None`` after a validation
        error has been sent. Callers should ``return`` immediately on
        ``None``.
    """
    from pdv.comms import get_pdv_tree, send_error  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})

    for field in required_fields:
        if not payload.get(field):
            send_error(
                response_type,
                f"{code_prefix}.missing_{field}",
                f"{field} is required in {response_type[: -len('.response')]} payload",
                in_reply_to=msg_id,
            )
            return None

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            response_type,
            f"{code_prefix}.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return None

    return tree, payload


def resolve_namelist_node(
    msg: dict,
    response_type: str,
) -> tuple[Any, Any, str, dict] | None:
    """Resolve a :class:`PDVNamelist` node from the tree for a namelist op.

    Encapsulates the ~40 lines of validation shared by
    :func:`handle_namelist_read` and :func:`handle_namelist_write`:
    extract ``tree_path`` from payload, fetch the tree, look up the node,
    type-check it as a PDVNamelist, and resolve its file path.

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    response_type : str
        The ``pdv.namelist.<read|write>.response`` type used when
        sending validation errors.

    Returns
    -------
    tuple[PDVTree, PDVNamelist, str, dict] or None
        ``(tree, node, file_path, payload)`` on success, or ``None``
        after an error has been sent.
    """
    from pdv.comms import get_pdv_tree, send_error  # noqa: PLC0415
    from pdv.tree import PDVNamelist  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    tree_path = payload.get("tree_path", "")

    if not tree_path:
        send_error(
            response_type,
            "namelist.missing_tree_path",
            f"tree_path is required in {response_type[: -len('.response')]} payload",
            in_reply_to=msg_id,
        )
        return None

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            response_type,
            "namelist.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return None

    try:
        node = tree[tree_path]
    except KeyError:
        send_error(
            response_type,
            "namelist.path_not_found",
            f"Tree path not found: '{tree_path}'",
            in_reply_to=msg_id,
        )
        return None

    if not isinstance(node, PDVNamelist):
        send_error(
            response_type,
            "namelist.wrong_type",
            f"Node at '{tree_path}' is not a PDVNamelist (got {type(node).__name__})",
            in_reply_to=msg_id,
        )
        return None

    file_path = node.resolve_path(tree._working_dir)
    return tree, node, file_path, payload


def attach_gui_to_module(tree: Any, parent_path: str, gui_node: Any) -> None:
    """Attach a :class:`PDVGui` to its parent if the parent is a PDVModule.

    The lookup is best-effort: if the parent path doesn't exist or the
    parent is not a module, the call is a no-op. Used by both the
    ``pdv.gui.register`` handler and (via the shared loader) the project
    and module loaders.

    Parameters
    ----------
    tree : PDVTree
        The root tree to look up the parent in.
    parent_path : str
        Dot-separated path of the parent node. Empty string disables
        attachment.
    gui_node : PDVGui
        The GUI node to attach.
    """
    if not parent_path:
        return
    from pdv.tree import PDVModule  # noqa: PLC0415

    try:
        parent = tree[parent_path]
    except (KeyError, AttributeError):
        return
    if isinstance(parent, PDVModule):
        parent.gui = gui_node
