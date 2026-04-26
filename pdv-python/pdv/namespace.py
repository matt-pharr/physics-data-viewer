"""
pdv.namespace — Protected kernel namespace and variable inspection.

This module provides:

- :class:`PDVNamespace`: a dict subclass used as the IPython user
  namespace. Blocks reassignment of ``pdv_tree`` and ``pdv``.

- :class:`PDVApp`: the ``pdv`` object injected into the namespace.
  Exposes ``pdv.save()``, ``pdv.save_project()``,
  ``pdv.save_project_as()``, ``pdv.open_project()``,
  ``pdv.help()`` to users.

- :func:`pdv_namespace`: returns a snapshot of the current kernel
  namespace for display in the Namespace panel, excluding PDV internals
  and private names.

See Also
--------
ARCHITECTURE.md §5.4 (protected namespace), §5.5 (user-facing names)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pdv.errors import PDVError, PDVProtectedNameError

# Names that must never be reassigned by user code.
_PROTECTED_NAMES: frozenset[str] = frozenset({"pdv_tree", "pdv"})


class PDVNamespace(dict):
    """
    Protected dict used as the IPython user namespace.

    Raises :class:`PDVProtectedNameError` if user code attempts to
    assign to ``pdv_tree`` or ``pdv``. All other assignments behave
    normally.

    See Also
    --------
    ARCHITECTURE.md §5.4
    """

    def __setitem__(self, key: str, value: Any) -> None:
        """Block reassignment of protected names.

        Parameters
        ----------
        key : str
            Variable name being assigned.
        value : Any
            Value being assigned.

        Raises
        ------
        PDVProtectedNameError
            If ``key`` is in :data:`_PROTECTED_NAMES`.
        """
        if key in _PROTECTED_NAMES:
            raise PDVProtectedNameError(
                f"'{key}' is a protected PDV object and cannot be reassigned. "
                "Use pdv_tree['key'] = value to store data in the tree."
            )
        super().__setitem__(key, value)

    def __delitem__(self, key: str) -> None:
        """Block deletion of protected names.

        Parameters
        ----------
        key : str
            Variable name being deleted.

        Raises
        ------
        PDVProtectedNameError
            If ``key`` is in :data:`_PROTECTED_NAMES`.
        """
        if key in _PROTECTED_NAMES:
            raise PDVProtectedNameError(
                f"'{key}' is a protected PDV object and cannot be deleted."
            )
        super().__delitem__(key)


class PDVApp:
    """
    The ``pdv`` object injected into the kernel namespace.

    Exposes app-level operations to the user. Tab-completing ``pdv.``
    reveals all available operations.

    See Also
    --------
    ARCHITECTURE.md §5.5
    """

    @property
    def working_dir(self) -> Path:
        """Filesystem path to the current kernel working directory.

        This is the on-disk root that PDV uses to store scripts, files,
        and other tree-backed content for the current session. It is the
        per-session temp dir until the project is saved, and stays stable
        for the lifetime of the kernel. Use it to locate data files that
        should live alongside the tree::

            np.loadtxt(pdv.working_dir / "data.csv")

        The kernel's own ``os.getcwd()`` defaults to the user's home
        directory and is never changed by PDV, so relative paths in
        ``open()`` do **not** resolve here unless the user explicitly
        ``os.chdir``s. Files written under ``pdv.working_dir`` are
        scratch unless attached to the tree as ``PDVFile`` nodes — the
        tree is the only persistent surface.
        """
        from pdv.comms import get_pdv_tree  # noqa: PLC0415

        tree = get_pdv_tree()
        if tree is None or not getattr(tree, "_working_dir", None):
            raise PDVError(
                "pdv.working_dir is not available: kernel has not received pdv.init"
            )
        return Path(tree._working_dir)

    def save(self) -> None:
        """Trigger a project save. Equivalent to File -> Save in the UI.

        Sends a ``pdv.project.save_request`` push to the app. The app
        will prompt for a save location if no project is currently open.
        """
        try:
            from pdv.comms import send_message  # noqa: PLC0415

            send_message("pdv.project.save_request", {})
        except RuntimeError:
            print("PDV: No comm channel open. Cannot trigger save.")

    def save_project(self, path: str | None = None) -> None:
        """Save the current project to a directory.

        Serializes the tree synchronously (avoiding a comm round-trip
        that would deadlock while the kernel shell is busy), then sends
        a ``pdv.project.save_completed`` push so the app can write the
        remaining manifest and code-cell files.

        Parameters
        ----------
        path : str or None
            Absolute or ``~``-prefixed path to the project directory.
            If None, saves to the current project location (falls back
            to :meth:`save` if no project is open).
        """
        try:
            import os  # noqa: PLC0415

            from pdv.comms import get_pdv_tree, send_message  # noqa: PLC0415

            tree = get_pdv_tree()
            if tree is None:
                print("PDV: Tree is not initialized. Cannot save.")
                return

            save_dir: str | None = None
            if path is not None:
                save_dir = os.path.realpath(os.path.expanduser(path))
            else:
                save_dir = getattr(tree, "_save_dir", None)

            if not save_dir:
                send_message("pdv.project.save_request", {})
                return

            from pdv.handlers.project import serialize_tree_to_dir  # noqa: PLC0415

            results = serialize_tree_to_dir(tree, save_dir)
            send_message(
                "pdv.project.save_completed",
                {"save_dir": save_dir, **results},
            )
        except RuntimeError:
            print("PDV: No comm channel open. Cannot trigger save.")
        except Exception as exc:  # noqa: BLE001
            print(f"PDV: save_project failed: {exc}")

    def save_project_as(self, path: str) -> None:
        """Save the project to a new directory (Save As).

        Like :meth:`save_project`, but the given path becomes the new
        active project directory.

        Parameters
        ----------
        path : str
            Absolute or ``~``-prefixed path to the new project directory.
        """
        try:
            import os  # noqa: PLC0415

            from pdv.comms import get_pdv_tree, send_message  # noqa: PLC0415

            tree = get_pdv_tree()
            if tree is None:
                print("PDV: Tree is not initialized. Cannot save.")
                return

            resolved = os.path.realpath(os.path.expanduser(path))

            from pdv.handlers.project import serialize_tree_to_dir  # noqa: PLC0415

            results = serialize_tree_to_dir(tree, resolved)
            send_message(
                "pdv.project.save_completed",
                {"save_dir": resolved, **results},
            )
        except RuntimeError:
            print("PDV: No comm channel open. Cannot trigger save.")
        except Exception as exc:  # noqa: BLE001
            print(f"PDV: save_project_as failed: {exc}")

    def open_project(self, path: str) -> None:
        """Open a project from a directory.

        Sends a request to the app to load the project at the given
        path. The current tree and code cells will be replaced with
        the contents of the loaded project.

        Parameters
        ----------
        path : str
            Absolute or ``~``-prefixed path to the project directory.
        """
        try:
            import os  # noqa: PLC0415

            from pdv.comms import send_message  # noqa: PLC0415

            resolved = os.path.realpath(os.path.expanduser(path))
            send_message("pdv.project.open_request", {"save_dir": resolved})
        except RuntimeError:
            print("PDV: No comm channel open. Cannot open project.")

    def add_file(self, source_path: str) -> "PDVFile":
        """Import an arbitrary file into the tree as a :class:`PDVFile`.

        Eagerly copies the source file into the session working directory
        under a fresh UUID-based storage path. The returned node is not
        yet attached to the tree — assign it at the desired tree path::

            mesh = pdv.add_file("~/Downloads/mesh.h5")
            pdv_tree["simulation.mesh"] = mesh

        If the returned node is never assigned to the tree, the copied
        file is cleaned up when the kernel's temp working dir is wiped
        at session end.

        Parameters
        ----------
        source_path : str
            Filesystem path to the source file. ``~`` is expanded.

        Returns
        -------
        PDVFile
            A new file-backed node wrapping the imported file.

        Raises
        ------
        FileNotFoundError
            If ``source_path`` does not exist.
        ValueError
            If ``source_path`` is not a regular file.
        PDVError
            If no kernel working directory is available (the kernel has
            not yet received ``pdv.init``).
        """
        import os  # noqa: PLC0415

        from pdv.comms import get_pdv_tree  # noqa: PLC0415
        from pdv.environment import (  # noqa: PLC0415
            generate_node_uuid,
            smart_copy,
            uuid_tree_path,
        )
        from pdv.tree import PDVFile  # noqa: PLC0415

        resolved = os.path.realpath(os.path.expanduser(source_path))
        if not os.path.exists(resolved):
            raise FileNotFoundError(f"Source file not found: {source_path}")
        if not os.path.isfile(resolved):
            raise ValueError(f"Source path is not a file: {source_path}")

        tree = get_pdv_tree()
        working_dir = getattr(tree, "_working_dir", None) if tree is not None else None
        if not working_dir:
            raise PDVError(
                "pdv.add_file is not available: kernel has not received pdv.init"
            )

        filename = os.path.basename(resolved)
        node_uuid = generate_node_uuid()
        dest = uuid_tree_path(working_dir, node_uuid, filename)
        smart_copy(resolved, dest)
        return PDVFile(uuid=node_uuid, filename=filename)

    def new_note(self, path: str, title: str | None = None) -> None:
        """Create a markdown note in the tree.

        Creates a ``.md`` file in the working directory and registers
        it as a ``markdown`` node at the given tree path.

        Parameters
        ----------
        path : str
            Dot-separated tree path for the new note
            (e.g. ``'notes.intro'``).
        title : str or None
            Optional title. If provided, the file is initialized with
            a ``# Title`` heading. Otherwise the file starts empty.
        """
        import os  # noqa: PLC0415

        from pdv.comms import get_pdv_tree  # noqa: PLC0415
        from pdv.tree import PDVNote  # noqa: PLC0415

        tree = get_pdv_tree()
        if tree is None:
            print("PDV: Tree is not initialized. Cannot create note.")
            return

        from pdv.environment import ensure_parent, generate_node_uuid, uuid_tree_path  # noqa: PLC0415

        working_dir = getattr(tree, "_working_dir", None) or "."
        segments = path.split(".")
        filename = segments[-1] + ".md"
        node_uuid = generate_node_uuid()
        file_path = uuid_tree_path(working_dir, node_uuid, filename)
        ensure_parent(file_path)

        if not os.path.exists(file_path):
            with open(file_path, "w", encoding="utf-8") as fh:
                if title:
                    fh.write(f"# {title}\n")

        note = PDVNote(uuid=node_uuid, filename=filename, title=title)
        tree[path] = note
        print(f"Created note at '{path}'")

    def help(self, topic: str | None = None) -> None:
        """Print PDV help.

        Parameters
        ----------
        topic : str, optional
            A specific topic to get help on (e.g. ``'pdv_tree'``,
            ``'run_script'``). If None, prints a general overview.
        """
        if topic is None:
            print(
                "PDV Help\n"
                "--------\n"
                "  pdv_tree          — the project data tree (dict-like)\n"
                "  pdv_tree['path']  — access or set a node by dot-path\n"
                "  pdv_tree.run_script('path') — run a script node\n"
                "  pdv.working_dir   — Path to the session working dir (for data files)\n"
                "  pdv.save()        — save the project\n"
                "  pdv.save_project('path')    — save project to a directory\n"
                "  pdv.save_project_as('path') — save project to a new directory (Save As)\n"
                "  pdv.open_project('path')    — open a project from a directory\n"
                "  pdv.add_file('path/to/file') — import a file into the tree\n"
                "  pdv.new_note('path', title='My Note') — create a markdown note\n"
                "  pdv.help('pdv_tree') — help on a specific topic\n"
            )
        else:
            print(f"PDV help for topic '{topic}' is not yet implemented.")

    def __getattr__(self, name: str) -> Any:
        import sys  # noqa: PLC0415

        pdv_module = sys.modules.get("pdv")
        if pdv_module is not None:
            try:
                return getattr(pdv_module, name)
            except (AttributeError, RuntimeError):
                pass
        raise AttributeError(f"'PDVApp' object has no attribute {name!r}")

    def __repr__(self) -> str:
        return "<PDV app object — type pdv.help() for usage>"


def pdv_namespace(
    ns: dict,
    *,
    include_private: bool = False,
    include_modules: bool = False,
    include_callables: bool = False,
) -> dict:
    """Return a snapshot of the kernel namespace for the Namespace panel.

    Excludes PDV internals (``pdv_tree``, ``pdv``, and any name starting
    with ``_pdv``). Optionally filters private names (``_``-prefixed),
    modules, and callables.

    Parameters
    ----------
    ns : dict
        The kernel user namespace (a :class:`PDVNamespace` instance in
        production; may be a plain dict in tests).
    include_private : bool
        If True, include names starting with ``_``. Default False.
    include_modules : bool
        If True, include imported modules. Default False.
    include_callables : bool
        If True, include functions and classes. Default False.

    Returns
    -------
    dict
        Mapping of variable name → variable descriptor dict. Each
        descriptor has at minimum: ``type``, ``preview``. Arrays and
        DataFrames also have ``shape``, ``dtype``; dicts have ``length``,
        etc. See ARCHITECTURE.md §3.4 (pdv.namespace.query.response).
    """
    import types  # noqa: PLC0415

    result: dict = {}

    for name, value in list(ns.items()):
        # Always exclude PDV internals
        if name in _PROTECTED_NAMES:
            continue
        # Exclude internal PDV names starting with _pdv
        if name.startswith("_pdv"):
            continue
        # Exclude private names unless requested
        if not include_private and name.startswith("_"):
            continue
        # Exclude modules unless requested
        if not include_modules and isinstance(value, types.ModuleType):
            continue
        # Exclude callables (functions/classes) unless requested
        if not include_callables and callable(value) and not isinstance(value, type):
            continue

        result[name] = describe_namespace_value(
            value,
            name=name,
            path=[],
            expression=name,
        )

    return result


def inspect_namespace(
    ns: dict,
    *,
    root_name: str,
    path: list[dict[str, Any]] | None = None,
    max_children: int = 50,
) -> dict[str, Any]:
    """Inspect one namespace value and return one level of child descriptors.

    Parameters
    ----------
    ns : dict
        Kernel namespace dictionary.
    root_name : str
        Top-level namespace variable to inspect.
    path : list of dict, optional
        Selector chain from the root variable to the current node.
    max_children : int
        Maximum number of child rows to return.

    Returns
    -------
    dict
        Response payload with ``children``, ``truncated``, and optional
        ``total_children``.
    """
    value = resolve_namespace_target(ns, root_name=root_name, path=path or [])
    children, total_children = describe_namespace_children(
        value,
        root_name=root_name,
        path=path or [],
        expression=build_namespace_expression(root_name, path or []),
        max_children=max_children,
    )
    payload: dict[str, Any] = {
        "children": children,
        "truncated": total_children > len(children),
    }
    if total_children >= 0:
        payload["total_children"] = total_children
    return payload


def describe_namespace_value(
    value: Any,
    *,
    name: str,
    path: list[dict[str, Any]],
    expression: str,
) -> dict[str, Any]:
    """Build a renderer-facing descriptor for one namespace value."""
    kind = namespace_kind(value)
    descriptor: dict[str, Any] = {
        "name": name,
        "kind": kind,
        "type": type(value).__name__ if value is not None else "NoneType",
        "preview": namespace_preview(value),
        "path": path,
        "expression": expression,
    }

    try:
        import numpy as np  # noqa: PLC0415

        if isinstance(value, np.ndarray):
            descriptor["shape"] = list(value.shape)
            descriptor["dtype"] = str(value.dtype)
            descriptor["size"] = int(value.nbytes)
    except ImportError:
        pass

    try:
        import pandas as pd  # noqa: PLC0415

        if isinstance(value, pd.DataFrame):
            descriptor["shape"] = list(value.shape)
        elif isinstance(value, pd.Series):
            descriptor["shape"] = [len(value)]
            descriptor["length"] = len(value)
    except ImportError:
        pass

    if isinstance(value, (list, tuple, dict, str, bytes, bytearray)):
        try:
            descriptor["length"] = len(value)
        except Exception:  # noqa: BLE001
            pass

    child_count = namespace_child_count(value)
    descriptor["has_children"] = child_count > 0
    if child_count >= 0:
        descriptor["child_count"] = child_count
    return descriptor


def namespace_kind(value: Any) -> str:
    """Return the canonical namespace inspector kind for a value."""
    from pdv.serialization import detect_kind  # noqa: PLC0415

    kind = detect_kind(value)
    if kind == "unknown" and value_has_object_children(value):
        return "object"
    return kind


def namespace_preview(value: Any, max_length: int = 120) -> str:
    """Return a rich but bounded preview string for a namespace value."""
    kind = namespace_kind(value)

    try:
        if kind == "ndarray":
            import numpy as np  # noqa: PLC0415

            body = np.array2string(
                value,
                threshold=10,
                edgeitems=3,
                separator=", ",
            )
            return trim_preview(
                f"array({body})",
                max_length=max_length,
            )
        if kind == "dataframe":
            columns = [str(col) for col in value.columns[:3]]
            more = ", ..." if len(value.columns) > 3 else ""
            return trim_preview(
                f"DataFrame[{value.shape[0]} x {value.shape[1]}] columns=[{', '.join(columns)}{more}]",
                max_length=max_length,
            )
        if kind == "series":
            import numpy as np  # noqa: PLC0415

            body = np.array2string(
                value.to_numpy(), threshold=10, edgeitems=3, separator=", "
            )
            return trim_preview(
                f"Series({body})",
                max_length=max_length,
            )
        if kind == "mapping":
            return trim_preview(repr(value), max_length=max_length)
        if kind == "sequence":
            return trim_preview(repr(value), max_length=max_length)
        if kind == "text":
            return trim_preview(repr(value), max_length=max_length)
        if kind == "binary":
            return f"bytes ({len(value)} bytes)"
        if kind == "object":
            attrs = list(iter_object_attributes(value).keys())
            summary = f"{type(value).__name__}({', '.join(attrs[:3])}"
            if len(attrs) > 3:
                summary += ", ..."
            summary += ")"
            return trim_preview(summary, max_length=max_length)
    except Exception:  # noqa: BLE001
        pass

    return trim_preview(safe_repr(value), max_length=max_length)


def safe_repr(value: Any) -> str:
    """Return ``repr(value)`` without letting repr failures escape."""
    try:
        return repr(value)
    except Exception:  # noqa: BLE001
        return "<unrepresentable>"


def trim_preview(text: str, *, max_length: int = 120) -> str:
    """Trim preview text to the configured display bound."""
    if len(text) <= max_length:
        return text
    return text[: max_length - 3] + "..."


def value_has_object_children(value: Any) -> bool:
    """Return True when a custom object exposes inspectable attributes."""
    return len(iter_object_attributes(value)) > 0


def iter_object_attributes(value: Any) -> dict[str, Any]:
    """Return a stable attribute mapping for object inspection."""
    try:
        from dataclasses import fields, is_dataclass  # noqa: PLC0415

        if is_dataclass(value):
            return {field.name: getattr(value, field.name) for field in fields(value)}
    except Exception:  # noqa: BLE001
        pass

    raw_dict = getattr(value, "__dict__", None)
    if isinstance(raw_dict, dict):
        return {
            key: raw_dict[key]
            for key in sorted(raw_dict.keys())
            if not str(key).startswith("_")
        }
    return {}


def namespace_child_count(value: Any) -> int:
    """Return child count for expandable values, or ``0`` for leaves."""
    kind = namespace_kind(value)
    if kind in {"mapping", "sequence", "text", "binary"}:
        try:
            return len(value)
        except Exception:  # noqa: BLE001
            return 0
    if kind == "ndarray":
        try:
            if value.ndim == 0:
                return 0
            return int(value.shape[0])
        except Exception:  # noqa: BLE001
            return 0
    if kind == "dataframe":
        try:
            return int(len(value.columns))
        except Exception:  # noqa: BLE001
            return 0
    if kind == "series":
        try:
            return int(len(value))
        except Exception:  # noqa: BLE001
            return 0
    if kind == "object":
        return len(iter_object_attributes(value))
    return 0


def build_namespace_expression(root_name: str, path: list[dict[str, Any]]) -> str:
    """Build a user-facing expression string from a selector path."""
    expression = root_name
    for segment in path:
        kind = segment.get("kind")
        value = segment.get("value")
        if kind == "attr":
            expression += f".{value}"
        elif kind == "column":
            expression += f"[{value!r}]"
        else:
            expression += f"[{value!r}]"
    return expression


def resolve_namespace_target(
    ns: dict,
    *,
    root_name: str,
    path: list[dict[str, Any]],
) -> Any:
    """Resolve a lazy-inspection target inside the namespace."""
    if root_name not in ns:
        raise KeyError(f"Namespace variable not found: {root_name}")
    value = ns[root_name]
    for segment in path:
        kind = segment.get("kind")
        raw = segment.get("value")
        if kind == "attr":
            value = getattr(value, str(raw))
            continue
        if kind == "column":
            value = value[raw]
            continue
        if kind == "index":
            value = resolve_index_child(value, raw)
            continue
        if kind == "key":
            value = value[raw]
            continue
        raise KeyError(f"Unsupported namespace selector kind: {kind}")
    return value


def resolve_index_child(value: Any, raw_index: Any) -> Any:
    """Resolve one positional child for arrays, sequences, and Series."""
    index = int(raw_index)
    try:
        import pandas as pd  # noqa: PLC0415

        if isinstance(value, pd.Series):
            return value.iloc[index]
    except ImportError:
        pass
    return value[index]


def describe_namespace_children(
    value: Any,
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of children for an expandable namespace value."""
    kind = namespace_kind(value)
    if kind == "mapping":
        return describe_mapping_children(
            value,
            root_name=root_name,
            path=path,
            expression=expression,
            max_children=max_children,
        )
    if kind == "sequence":
        return describe_sequence_children(
            value,
            root_name=root_name,
            path=path,
            expression=expression,
            max_children=max_children,
        )
    if kind == "ndarray":
        return describe_ndarray_children(
            value,
            root_name=root_name,
            path=path,
            expression=expression,
            max_children=max_children,
        )
    if kind == "dataframe":
        return describe_dataframe_children(
            value,
            root_name=root_name,
            path=path,
            expression=expression,
            max_children=max_children,
        )
    if kind == "series":
        return describe_series_children(
            value,
            root_name=root_name,
            path=path,
            expression=expression,
            max_children=max_children,
        )
    if kind == "object":
        return describe_object_children(
            value,
            root_name=root_name,
            path=path,
            expression=expression,
            max_children=max_children,
        )
    return [], 0


def describe_mapping_children(
    value: dict[Any, Any],
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of mapping entries."""
    items = list(value.items())
    children: list[dict[str, Any]] = []
    for key, child in items[:max_children]:
        is_supported, segment_value = primitive_namespace_value(key)
        child_path = [*path, {"kind": "key", "value": segment_value}]
        child_expression = f"{expression}[{key!r}]"
        descriptor = describe_namespace_value(
            child,
            name=repr(key),
            path=child_path,
            expression=child_expression,
        )
        if not is_supported:
            descriptor["has_children"] = False
            descriptor["child_count"] = 0
            descriptor["preview"] = trim_preview(
                f"{descriptor.get('preview', '<unknown>')} (non-serializable key)",
            )
        children.append(descriptor)
    return children, len(items)


def describe_sequence_children(
    value: list[Any] | tuple[Any, ...],
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of sequence items."""
    children = []
    total = len(value)
    for index, child in enumerate(value[:max_children]):
        child_path = [*path, {"kind": "index", "value": index}]
        children.append(
            describe_namespace_value(
                child,
                name=f"[{index}]",
                path=child_path,
                expression=f"{expression}[{index}]",
            )
        )
    return children, total


def describe_ndarray_children(
    value: Any,
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of ndarray children."""
    if getattr(value, "ndim", 0) == 0:
        return [], 0
    total = int(value.shape[0])
    children = []
    limit = min(total, max_children)
    for index in range(limit):
        child = value[index]
        child_path = [*path, {"kind": "index", "value": index}]
        children.append(
            describe_namespace_value(
                child,
                name=f"[{index}]",
                path=child_path,
                expression=f"{expression}[{index}]",
            )
        )
    return children, total


def describe_dataframe_children(
    value: Any,
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of DataFrame column children."""
    columns = list(value.columns)
    children = []
    for column in columns[:max_children]:
        is_supported, segment_value = primitive_namespace_value(column)
        child = value[column]
        child_path = [*path, {"kind": "column", "value": segment_value}]
        child_expression = f"{expression}[{column!r}]"
        descriptor = describe_namespace_value(
            child,
            name=str(column),
            path=child_path,
            expression=child_expression,
        )
        if not is_supported:
            descriptor["has_children"] = False
            descriptor["child_count"] = 0
        children.append(descriptor)
    return children, len(columns)


def describe_series_children(
    value: Any,
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of Series positional children."""
    total = len(value)
    children = []
    limit = min(total, max_children)
    for index in range(limit):
        child = value.iloc[index]
        child_path = [*path, {"kind": "index", "value": index}]
        label = f"[{index}]"
        children.append(
            describe_namespace_value(
                child,
                name=label,
                path=child_path,
                expression=f"{expression}[{index}]",
            )
        )
    return children, total


def describe_object_children(
    value: Any,
    *,
    root_name: str,
    path: list[dict[str, Any]],
    expression: str,
    max_children: int,
) -> tuple[list[dict[str, Any]], int]:
    """Describe one level of object attribute children."""
    attrs = iter_object_attributes(value)
    names = list(attrs.keys())
    children = []
    for attr_name in names[:max_children]:
        child_path = [*path, {"kind": "attr", "value": attr_name}]
        children.append(
            describe_namespace_value(
                attrs[attr_name],
                name=attr_name,
                path=child_path,
                expression=f"{expression}.{attr_name}",
            )
        )
    return children, len(names)


def primitive_namespace_value(
    value: Any,
) -> tuple[bool, str | int | float | bool | None]:
    """Return a JSON-safe selector value, with support flag."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return True, value
    return False, safe_repr(value)
