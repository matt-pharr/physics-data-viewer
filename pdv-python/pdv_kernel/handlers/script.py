"""
pdv_kernel.handlers.script — Handlers for PDV script messages.

Handles:
- ``pdv.script.register``: attach a :class:`PDVScript` node to the tree
  at the specified parent path and name.
- ``pdv.script.params``: extract the current ``run()`` parameters from a
  script file on disk.

See Also
--------
ARCHITECTURE.md §3.4 (script messages)
pdv_kernel.tree.PDVScript
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_script_register(msg: dict) -> None:
    """Handle the ``pdv.script.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVScript` and attaches it to the
    tree at ``parent_path.name``. Sends a ``pdv.tree.changed`` push
    notification on success.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "scripts.analysis",
            "name": "fit_model",
            "relative_path": "tree/scripts/analysis/fit_model.py",
            "language": "python"
        }

    Response type: ``pdv.script.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVScript  # noqa: PLC0415
    from pdv_kernel.handlers._helpers import validate_register_request  # noqa: PLC0415

    validated = validate_register_request(msg, "pdv.script.register.response", "script")
    if validated is None:
        return
    tree, payload = validated
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    relative_path = payload.get("relative_path", "")
    language = payload.get("language", "python")
    source_rel_path = payload.get("source_rel_path")
    module_id = payload.get("module_id", "")

    script = PDVScript(
        relative_path=relative_path,
        language=language,
        module_id=module_id,
        source_rel_path=source_rel_path,
    )
    full_path = f"{parent_path}.{name}" if parent_path else name
    tree[full_path] = script

    send_message(
        "pdv.script.register.response",
        {"path": full_path},
        in_reply_to=msg.get("msg_id"),
    )


register("pdv.script.register", handle_script_register)


def handle_script_params(msg: dict) -> None:
    """Handle the ``pdv.script.params`` message.

    Extracts the current ``run()`` parameters from a script file on disk.
    Always reads the file fresh so edits are reflected immediately.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "path": "scripts.analysis.fit_model"
        }

    Response type: ``pdv.script.params.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVScript, _extract_script_params  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    tree_path = payload.get("path", "")

    if not tree_path:
        send_error(
            "pdv.script.params.response",
            "script.missing_path",
            "path is required in pdv.script.params payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.script.params.response",
            "script.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    try:
        node = tree[tree_path]
    except (KeyError, TypeError):
        send_error(
            "pdv.script.params.response",
            "script.not_found",
            f"No node at path: {tree_path}",
            in_reply_to=msg_id,
        )
        return

    if not isinstance(node, PDVScript):
        send_error(
            "pdv.script.params.response",
            "script.not_a_script",
            f"Node at {tree_path} is not a PDVScript",
            in_reply_to=msg_id,
        )
        return

    working_dir = getattr(tree, "_working_dir", None)
    resolved_path = node.resolve_path(working_dir)
    params = _extract_script_params(resolved_path)

    send_message("pdv.script.params.response", {"params": params}, in_reply_to=msg_id)


register("pdv.script.params", handle_script_params)
