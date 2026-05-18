"""
pdv.handlers.introspection — introspection and path-resolution handlers
used by the MCP server.

Handles:
- ``pdv.help``: resolve a dotted symbol to a live Python object and return
  its kind, signature, docstring, and (optionally) source.
- ``pdv.tree.resolve_path``: translate between a dot-delimited tree path and
  an absolute filesystem path, in either direction.

These handlers exist to give the PDV MCP server read-only insight into the
kernel namespace and the file-backed tree nodes without needing to execute
arbitrary code.

See Also
--------
ARCHITECTURE.md §15 (MCP server)
"""

from __future__ import annotations

import importlib
import inspect
import os
from typing import Any

from pdv.handlers import register


def _resolve_symbol(symbol: str) -> Any:
    """Resolve a dotted symbol string to a live Python object.

    Splits *symbol* on ``.``. The head is looked up first in the kernel
    user namespace, and failing that imported as a module. The remaining
    parts are walked with :func:`getattr`.

    Parameters
    ----------
    symbol : str
        A dotted symbol, e.g. ``'pdv'``, ``'pdv.add_file'``,
        ``'numpy.ndarray'``, or a bare user-namespace variable name.

    Returns
    -------
    Any
        The resolved live object.

    Raises
    ------
    KeyError, AttributeError, ImportError, ValueError
        If the symbol cannot be resolved at any step.
    """
    from pdv.comms import get_ip  # noqa: PLC0415

    if not symbol:
        raise ValueError("symbol must be a non-empty string")

    parts = symbol.split(".")
    head, *rest = parts

    ip = get_ip()
    user_ns = ip.user_ns if ip is not None else {}

    if head in user_ns:
        obj: Any = user_ns[head]
    else:
        # Not in the namespace — try importing it as a module. Walk the
        # longest importable dotted prefix so e.g. ``numpy.linalg.norm``
        # imports ``numpy.linalg`` and then getattrs ``norm``.
        obj = importlib.import_module(head)
        while rest:
            try:
                obj = importlib.import_module(f"{head}.{rest[0]}")
            except ImportError:
                break
            head = f"{head}.{rest[0]}"
            rest = rest[1:]

    for attr in rest:
        obj = getattr(obj, attr)
    return obj


def _object_kind(obj: Any) -> str:
    """Return a coarse string label describing what kind of object *obj* is.

    Parameters
    ----------
    obj : Any
        The object to classify.

    Returns
    -------
    str
        One of ``'module'``, ``'class'``, ``'method'``, ``'function'``,
        or ``'object'``.
    """
    if inspect.ismodule(obj):
        return "module"
    if inspect.isclass(obj):
        return "class"
    if inspect.ismethod(obj):
        return "method"
    if inspect.isfunction(obj) or inspect.isbuiltin(obj) or inspect.isroutine(obj):
        return "function"
    return "object"


def handle_help(msg: dict) -> None:
    """Handle the ``pdv.help`` message.

    Resolves a dotted symbol to a live Python object and returns
    introspection metadata for it.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "symbol": "pdv.add_file",
            "include_source": false
        }

    ``include_source`` is optional and defaults to ``false``.

    Response payload (``pdv.help.response``)
    ----------------------------------------
    .. code-block:: json

        {
            "symbol": "pdv.add_file",
            "kind": "function",
            "signature": "(source_path: str) -> PDVFile",
            "doc": "Import an arbitrary file ...",
            "source": null
        }

    ``signature``, ``doc``, and ``source`` are ``null`` when not
    introspectable. ``source`` is only ever populated when
    ``include_source`` is true.

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv.comms import send_error, send_message  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    symbol = payload.get("symbol", "")
    include_source = bool(payload.get("include_source", False))

    if not symbol:
        send_error(
            "pdv.help.response",
            "introspection.missing_symbol",
            "symbol is required in pdv.help payload",
            in_reply_to=msg_id,
        )
        return

    try:
        obj = _resolve_symbol(symbol)
    except (KeyError, AttributeError, ImportError, ValueError, TypeError) as exc:
        send_error(
            "pdv.help.response",
            "introspection.symbol_not_found",
            f"Could not resolve symbol '{symbol}': {exc}",
            in_reply_to=msg_id,
        )
        return

    kind = _object_kind(obj)

    signature: str | None = None
    try:
        signature = str(inspect.signature(obj))
    except (TypeError, ValueError):
        signature = None

    doc: str | None = None
    try:
        doc = inspect.getdoc(obj)
    except Exception:  # noqa: BLE001
        doc = None

    source: str | None = None
    if include_source:
        try:
            source = inspect.getsource(obj)
        except (OSError, TypeError):
            source = None

    send_message(
        "pdv.help.response",
        {
            "symbol": symbol,
            "kind": kind,
            "signature": signature,
            "doc": doc,
            "source": source,
        },
        in_reply_to=msg_id,
    )


def _collect_file_nodes(
    value: Any,
    tree_path: str,
    out: list[tuple[str, Any]],
) -> None:
    """Recursively collect ``(tree_path, PDVFile)`` pairs from a container.

    Walks dicts (including PDVTree) accumulating every :class:`PDVFile`
    node it encounters, keyed by its dot-delimited tree path.

    Parameters
    ----------
    value : Any
        The current node value being walked.
    tree_path : str
        Dot-delimited path of *value* within the root tree.
    out : list[tuple[str, PDVFile]]
        Accumulator that collected pairs are appended to.
    """
    from pdv.tree import PDVFile  # noqa: PLC0415

    if isinstance(value, PDVFile):
        out.append((tree_path, value))
        return
    if isinstance(value, dict):
        for key in list(dict.keys(value)):
            child = dict.__getitem__(value, key)
            child_path = f"{tree_path}.{key}" if tree_path else key
            _collect_file_nodes(child, child_path, out)


def _extract_uuid_segment(abs_path: str) -> str | None:
    """Extract the ``<uuid>`` segment from a path under a ``tree/`` directory.

    A UUID-based file lives at ``<working_dir>/tree/<uuid>/<filename>``.
    If *abs_path* points at or inside such a ``tree/<uuid>/`` directory,
    return the ``<uuid>`` segment; otherwise return ``None``.

    Parameters
    ----------
    abs_path : str
        An absolute filesystem path.

    Returns
    -------
    str or None
        The UUID path segment, or ``None`` if *abs_path* is not inside a
        ``tree/<uuid>/`` directory.
    """
    parts = os.path.normpath(abs_path).split(os.sep)
    for index, part in enumerate(parts):
        if part == "tree" and index + 1 < len(parts):
            candidate = parts[index + 1]
            if candidate:
                return candidate
    return None


def handle_resolve_path(msg: dict) -> None:
    """Handle the ``pdv.tree.resolve_path`` message.

    Bidirectional path translation between a dot-delimited tree path and
    an absolute filesystem path.

    Expected payload
    ----------------
    .. code-block:: json

        { "path": "scripts.analysis.fit_model" }

    Direction is detected from *path*: an absolute filesystem path is
    treated as a reverse lookup (file → tree path(s)); anything else is a
    forward lookup (tree path → file path).

    Response payload (``pdv.tree.resolve_path.response``)
    -----------------------------------------------------
    .. code-block:: json

        {
            "input": "scripts.analysis.fit_model",
            "tree_paths": ["scripts.analysis.fit_model"],
            "file_path": "/abs/path/tree/<uuid>/fit_model.py"
        }

    ``file_path`` is ``null`` when the tree node is not file-backed (or,
    for reverse lookups, when no file path can be resolved). ``tree_paths``
    may contain multiple entries when several nodes share a UUID (copies).

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

    if not path:
        send_error(
            "pdv.tree.resolve_path.response",
            "introspection.missing_path",
            "path is required in pdv.tree.resolve_path payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.tree.resolve_path.response",
            "tree.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    working_dir = getattr(tree, "_working_dir", None)

    if os.path.isabs(path):
        # Reverse: filesystem path -> tree path(s).
        target_real = os.path.realpath(path)
        target_uuid = _extract_uuid_segment(target_real)

        file_nodes: list[tuple[str, Any]] = []
        _collect_file_nodes(tree, "", file_nodes)

        tree_paths: list[str] = []
        for node_path, node in file_nodes:
            matched = False
            if target_uuid is not None and node.uuid == target_uuid:
                matched = True
            if not matched and working_dir:
                try:
                    node_real = os.path.realpath(node.resolve_path(working_dir))
                except (RuntimeError, ValueError):
                    node_real = None
                if node_real is not None and node_real == target_real:
                    matched = True
            if matched:
                tree_paths.append(node_path)

        send_message(
            "pdv.tree.resolve_path.response",
            {
                "input": path,
                "tree_paths": tree_paths,
                "file_path": target_real,
            },
            in_reply_to=msg_id,
        )
        return

    # Forward: tree path -> filesystem path.
    if path not in tree:
        send_error(
            "pdv.tree.resolve_path.response",
            "tree.path_not_found",
            f"No node at tree path: '{path}'",
            in_reply_to=msg_id,
        )
        return

    node = tree[path]
    file_path: str | None = None
    if isinstance(node, PDVFile):
        try:
            file_path = node.resolve_path(working_dir)
        except (RuntimeError, ValueError):
            file_path = None

    send_message(
        "pdv.tree.resolve_path.response",
        {
            "input": path,
            "tree_paths": [path],
            "file_path": file_path,
        },
        in_reply_to=msg_id,
    )


register("pdv.help", handle_help)
register("pdv.tree.resolve_path", handle_resolve_path)
