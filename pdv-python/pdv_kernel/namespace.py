"""
pdv_kernel.namespace — Protected kernel namespace and variable inspection.

This module provides:

- :class:`PDVNamespace`: a dict subclass used as the IPython user
  namespace. Blocks reassignment of ``pdv_tree`` and ``pdv``.

- :class:`PDVApp`: the ``pdv`` object injected into the namespace.
  Exposes ``pdv.save()``, ``pdv.help()`` to users.

- :func:`pdv_namespace`: returns a snapshot of the current kernel
  namespace for display in the Namespace panel, excluding PDV internals
  and private names.

See Also
--------
ARCHITECTURE.md §5.4 (protected namespace), §5.5 (user-facing names)
"""

from __future__ import annotations

from typing import Any

from pdv_kernel.errors import PDVProtectedNameError

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

    def save(self) -> None:
        """Trigger a project save. Equivalent to File -> Save in the UI.

        Sends a ``pdv.project.save`` comm message to the app. The app
        will prompt for a save location if no project is currently open.
        """
        try:
            from pdv_kernel.comms import send_message  # noqa: PLC0415

            send_message("pdv.project.save", {})
        except RuntimeError:
            print("PDV: No comm channel open. Cannot trigger save.")

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
                "  pdv.save()        — save the project\n"
                "  pdv.help('pdv_tree') — help on a specific topic\n"
            )
        else:
            print(f"PDV help for topic '{topic}' is not yet implemented.")

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

    from pdv_kernel.serialization import detect_kind, node_preview  # noqa: PLC0415

    _INTERNAL: frozenset[str] = frozenset({"pdv_tree", "pdv"})
    result: dict = {}

    for name, value in ns.items():
        # Always exclude PDV internals
        if name in _INTERNAL:
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

        try:
            kind = detect_kind(value)
            preview = node_preview(value, kind)
        except Exception:  # noqa: BLE001
            kind = "unknown"
            preview = "<unknown>"

        descriptor: dict = {"type": kind, "preview": preview}

        # Add extra metadata for common types
        try:
            import numpy as np  # noqa: PLC0415

            if isinstance(value, np.ndarray):
                descriptor["shape"] = list(value.shape)
                descriptor["dtype"] = str(value.dtype)
        except ImportError:
            pass
        try:
            import pandas as pd  # noqa: PLC0415

            if isinstance(value, pd.DataFrame):
                descriptor["shape"] = list(value.shape)
            elif isinstance(value, pd.Series):
                descriptor["shape"] = [len(value)]
        except ImportError:
            pass

        result[name] = descriptor

    return result
