"""
pdv.handlers.script — Handlers for PDV script messages.

Handles:
- ``pdv.script.register``: attach a :class:`PDVScript` node to the tree
  at the specified parent path and name.
- ``pdv.script.params``: extract the current ``run()`` parameters from a
  script file on disk.

See Also
--------
ARCHITECTURE.md §3.4 (script messages)
pdv.tree.PDVScript
"""

from __future__ import annotations

from pdv.handlers import register


def _extract_script_doc(file_path: str) -> str | None:
    """First line of the script's module docstring, for the tree preview.

    Parses the source with :mod:`ast` (never executes it). Returns ``None``
    when the file is missing, unparsable, or has no module docstring — the
    tree chip already says ``script``, so no fallback text is needed.

    Parameters
    ----------
    file_path : str
        Absolute path to the script source file.

    Returns
    -------
    str or None
        The first non-empty docstring line, capped at 200 characters.
    """
    import ast  # noqa: PLC0415

    try:
        with open(file_path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
    except Exception:  # noqa: BLE001 — missing/unparsable file: no preview
        return None
    doc = ast.get_docstring(tree)
    if not doc:
        return None
    for line in doc.splitlines():
        line = line.strip()
        if line:
            return line[:200]
    return None


def handle_script_register(msg: dict) -> None:
    """Handle the ``pdv.script.register`` message.

    Creates a :class:`~pdv.tree.PDVScript` and attaches it to the
    tree at ``parent_path.name``. Sends a ``pdv.tree.changed`` push
    notification on success.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "scripts.analysis",
            "name": "fit_model",
            "uuid": "a1b2c3d4e5f6",
            "filename": "fit_model.py",
            "language": "python"
        }

    Response type: ``pdv.script.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv.comms import send_message  # noqa: PLC0415
    from pdv.tree import PDVScript  # noqa: PLC0415
    from pdv.handlers._helpers import validate_register_request  # noqa: PLC0415

    validated = validate_register_request(msg, "pdv.script.register.response", "script")
    if validated is None:
        return
    tree, payload = validated
    parent_path = payload.get("parent_path", "")
    name = payload.get("name", "")
    node_uuid = payload.get("uuid", "")
    filename = payload.get("filename", "")
    language = payload.get("language", "python")
    source_rel_path = payload.get("source_rel_path")
    module_id = payload.get("module_id", "")

    # Tree-panel preview: first line of the module docstring (the file
    # already exists — the app writes the template before registering).
    from pdv.environment import uuid_tree_path  # noqa: PLC0415

    doc = None
    try:
        if tree._working_dir:
            doc = _extract_script_doc(
                uuid_tree_path(tree._working_dir, node_uuid, filename)
            )
    except Exception:  # noqa: BLE001
        doc = None

    script = PDVScript(
        uuid=node_uuid,
        filename=filename,
        language=language,
        module_id=module_id,
        source_rel_path=source_rel_path,
        doc=doc,
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
    from pdv.comms import send_error, send_message  # noqa: PLC0415
    from pdv.tree import PDVScript, _extract_script_params  # noqa: PLC0415
    from pdv.handlers._helpers import validate_register_request  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    validated = validate_register_request(
        msg, "pdv.script.params.response", "script", required_fields=("path",)
    )
    if validated is None:
        return
    tree, payload = validated
    tree_path = payload.get("path", "")

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
    # Opportunistic freshness: the params dialog re-reads the file anyway, so
    # refresh the doc preview from the current source at the same time.
    try:
        node._doc = _extract_script_doc(resolved_path)
    except Exception:  # noqa: BLE001
        pass

    send_message("pdv.script.params.response", {"params": params}, in_reply_to=msg_id)


register("pdv.script.params", handle_script_params)
