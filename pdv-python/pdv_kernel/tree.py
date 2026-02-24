"""
pdv_kernel.tree — PDVTree and PDVScript data structures.

This module is the core of the pdv_kernel package. It implements:

- :class:`PDVTree`: a dict subclass that is the live project data tree.
  It supports dot-path access, a lazy-load registry for data backed by
  the project save directory, and emits ``pdv.tree.changed`` push
  notifications on mutation (when a comm is attached).

- :class:`PDVScript`: a lightweight wrapper for a script file stored as
  a tree node.

- :class:`LazyLoadRegistry`: internal registry mapping tree paths to
  save-directory storage references. Not user-accessible.

Design decisions recorded in ARCHITECTURE.md §5.6, §5.7, §5.8, §7.

This module has NO dependency on IPython, comms, or any Electron-facing
code. It can be imported and tested standalone.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import sys
from typing import Any, Callable

from pdv_kernel.errors import PDVKeyError, PDVPathError, PDVScriptError


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _split_dot_path(key: str) -> list[str]:
    """Split a dot-separated tree path into parts, validating each part.

    Parameters
    ----------
    key : str
        Dot-separated path string, e.g. ``'data.waveforms.ch1'``.

    Returns
    -------
    list[str]
        Non-empty list of path parts.

    Raises
    ------
    PDVPathError
        If any part is empty or contains illegal characters.
    """
    parts = key.split(".")
    for part in parts:
        if not part:
            raise PDVPathError(f"Tree path contains an empty segment: '{key}'")
    return parts


def _resolve_nested(obj: dict, parts: list[str]) -> Any:
    """Recursively resolve a list of path parts through nested dicts.

    Parameters
    ----------
    obj : dict
        Starting object.
    parts : list[str]
        Remaining path parts to traverse.

    Returns
    -------
    Any
        The value at the end of the path.

    Raises
    ------
    KeyError
        If any part is not found at its level.
    """
    current = obj
    for part in parts:
        if not isinstance(current, dict):
            raise KeyError(part)
        current = dict.__getitem__(current, part)
    return current


# ---------------------------------------------------------------------------
# LazyLoadRegistry
# ---------------------------------------------------------------------------

class LazyLoadRegistry:
    """
    Internal registry mapping tree paths to save-directory storage references.

    Populated when a project is loaded from disk (``pdv.project.load``).
    Entries are removed once data has been fetched into memory.
    Never written to disk — reconstructed from ``tree-index.json`` each load.

    Not user-accessible. Used only by :class:`PDVTree.__getitem__`.

    See Also
    --------
    ARCHITECTURE.md §5.8
    """

    def __init__(self) -> None:
        self._registry: dict[str, dict] = {}

    def register(self, path: str, storage_ref: dict) -> None:
        """Register a lazy-load entry for a tree path.

        Parameters
        ----------
        path : str
            Dot-separated tree path (e.g. ``'data.waveforms.ch1'``).
        storage_ref : dict
            Storage reference dict as defined in ARCHITECTURE.md §7.3.
            Must contain at least ``backend``, ``relative_path``, and ``format``.
        """
        self._registry[path] = storage_ref

    def has(self, path: str) -> bool:
        """Return True if a lazy-load entry exists for this path."""
        return path in self._registry

    def fetch(self, path: str, save_dir: str) -> Any:
        """Load data from the save directory for this path and remove the registry entry.

        Parameters
        ----------
        path : str
            Dot-separated tree path.
        save_dir : str
            Absolute path to the project save directory.

        Returns
        -------
        Any
            Deserialized value.

        Raises
        ------
        PDVSerializationError
            If the file cannot be read or deserialized.
        """
        from pdv_kernel.serialization import deserialize_node  # noqa: PLC0415

        storage_ref = self._registry.pop(path)
        return deserialize_node(storage_ref, save_dir)

    def clear(self) -> None:
        """Remove all registry entries (called when a new project is loaded)."""
        self._registry.clear()

    def populate_from_index(self, nodes: list[dict]) -> None:
        """Populate the registry from a tree-index node list.

        Parameters
        ----------
        nodes : list[dict]
            Node descriptor dicts as defined in ARCHITECTURE.md §7.3.
            Only nodes with ``lazy: true`` are registered.
        """
        for node in nodes:
            if node.get("lazy", False) and node.get("storage", {}).get("backend") == "local_file":
                self.register(node["path"], node["storage"])


# ---------------------------------------------------------------------------
# PDVScript
# ---------------------------------------------------------------------------

class PDVScript:
    """
    Lightweight wrapper for a script file stored as a PDV tree node.

    Stored as the value at a tree path (e.g. ``pdv_tree['scripts.analysis.fit']``).
    Calling ``script.run(pdv_tree, **kwargs)`` loads the script module fresh
    (no cache) and calls its ``run(tree, **kwargs)`` function.

    Parameters
    ----------
    relative_path : str
        Path of the script file relative to the project root.
    language : str
        Language of the script. Currently only ``'python'`` is supported.
    doc : str or None
        First line of the script's docstring, used as a preview. If None,
        extracted from the file automatically.

    See Also
    --------
    ARCHITECTURE.md §5.7
    """

    def __init__(self, relative_path: str, language: str = "python", doc: str | None = None) -> None:
        self._relative_path = relative_path
        self._language = language
        self._doc = doc

    @property
    def relative_path(self) -> str:
        """Relative path from project root to the script file."""
        return self._relative_path

    @property
    def language(self) -> str:
        """Script language. Currently always ``'python'``."""
        return self._language

    @property
    def doc(self) -> str | None:
        """First line of the script docstring, or None."""
        return self._doc

    def preview(self) -> str:
        """Return a short human-readable preview string for the tree panel.

        Returns
        -------
        str
            The first line of the docstring, or a generic fallback.
        """
        if self._doc:
            return self._doc.split("\n")[0]
        return "PDV script"

    def run(self, tree: "PDVTree", **kwargs: Any) -> Any:
        """Load and execute the script, calling its ``run()`` function.

        Loads the module fresh on every call (no import cache). The
        script module must define a ``run(tree, **kwargs)`` function.

        Parameters
        ----------
        tree : PDVTree
            The live project data tree, passed as the first argument to
            the script's ``run()`` function.
        **kwargs
            Additional keyword arguments forwarded to ``run()``.

        Returns
        -------
        Any
            Return value of the script's ``run()`` function.

        Raises
        ------
        FileNotFoundError
            If the script file does not exist on disk.
        PDVScriptError
            If the script has no ``run()`` function, or if ``run()`` raises.
        """
        # Resolve file path: if absolute, use directly; otherwise join with working_dir
        if os.path.isabs(self._relative_path):
            file_path = self._relative_path
        elif hasattr(tree, "_working_dir") and tree._working_dir:
            file_path = os.path.join(tree._working_dir, self._relative_path)
        else:
            file_path = self._relative_path

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Script file not found: {file_path}")

        module_name = f"_pdv_script_{abs(hash(file_path))}"
        if module_name in sys.modules:
            del sys.modules[module_name]

        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec is None or spec.loader is None:
            raise PDVScriptError(f"Cannot load script: {file_path}")

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]

        if not hasattr(module, "run"):
            raise PDVScriptError(
                f"Script '{self._relative_path}' does not define a run() function"
            )

        try:
            return module.run(tree, **kwargs)
        except Exception as exc:
            raise PDVScriptError(
                f"Script '{self._relative_path}' raised during run(): {exc}"
            ) from exc

    def __repr__(self) -> str:
        return f"PDVScript('{self._relative_path}', lang='{self._language}')"


# ---------------------------------------------------------------------------
# PDVTree
# ---------------------------------------------------------------------------

class PDVTree(dict):
    """
    The live project data tree. The sole authority on all project data.

    A dict subclass that supports:

    - Dot-path access: ``pdv_tree['data.waveforms.ch1']``
    - Lazy loading: if a key is absent from memory but present in the
      :class:`LazyLoadRegistry`, the data is fetched from the save
      directory transparently.
    - Change notification: mutations emit a ``pdv.tree.changed`` comm
      push notification (when a comm is attached via ``_attach_comm``).
    - Script execution: ``pdv_tree.run_script('scripts.analysis.fit', x=1)``

    Injected into the kernel namespace as ``pdv_tree`` (protected — cannot
    be reassigned).

    Parameters
    ----------
    *args, **kwargs
        Forwarded to dict.__init__.

    See Also
    --------
    ARCHITECTURE.md §5.6, §7.1
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._lazy_registry: LazyLoadRegistry = LazyLoadRegistry()
        self._working_dir: str | None = None
        self._save_dir: str | None = None
        self._send_fn: Callable[[str, dict], None] | None = None

    # ------------------------------------------------------------------
    # Internal state management (not user-facing)
    # ------------------------------------------------------------------

    def _set_working_dir(self, path: str) -> None:
        """Set the working directory path. Called by lifecycle handler after pdv.init."""
        self._working_dir = path

    def _set_save_dir(self, path: str | None) -> None:
        """Set the save directory path. None means no project is loaded."""
        self._save_dir = path

    def _attach_comm(self, send_fn: Callable[[str, dict], None]) -> None:
        """Attach a comm send function for push notifications.

        Parameters
        ----------
        send_fn : callable
            Function with signature ``(type: str, payload: dict) -> None``.
            Called when the tree changes.
        """
        self._send_fn = send_fn

    def _detach_comm(self) -> None:
        """Detach the comm send function (e.g. on kernel restart)."""
        self._send_fn = None

    def _emit_changed(self, path: str, change_type: str) -> None:
        """Emit a pdv.tree.changed push notification if a comm is attached.

        Parameters
        ----------
        path : str
            The dot-separated path that changed.
        change_type : str
            One of ``'added'``, ``'removed'``, or ``'updated'``.
        """
        if self._send_fn is not None:
            self._send_fn(
                "pdv.tree.changed",
                {"changed_paths": [path], "change_type": change_type},
            )

    # ------------------------------------------------------------------
    # dict overrides
    # ------------------------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        """Get a value by key or dot-separated path.

        If the key is not in memory but is in the lazy-load registry,
        fetches the data from the save directory transparently.

        Parameters
        ----------
        key : str
            A plain key (``'data'``) or dot-separated path
            (``'data.waveforms.ch1'``).

        Returns
        -------
        Any
            The value at that path.

        Raises
        ------
        PDVKeyError
            If the key is absent from memory and from the lazy-load registry.
        """
        parts = _split_dot_path(key)

        if len(parts) == 1:
            p = parts[0]
            if dict.__contains__(self, p):
                return dict.__getitem__(self, p)
            if self._lazy_registry.has(p):
                val = self._lazy_registry.fetch(p, self._save_dir or "")
                dict.__setitem__(self, p, val)
                return val
            raise PDVKeyError(key)

        # Multi-part: check the full path in the lazy registry first
        if self._lazy_registry.has(key):
            val = self._lazy_registry.fetch(key, self._save_dir or "")
            # Store value at the leaf position in the nested structure
            parent = self
            for part in parts[:-1]:
                if not dict.__contains__(parent, part):
                    new_node: PDVTree = PDVTree()
                    new_node._lazy_registry = self._lazy_registry
                    dict.__setitem__(parent, part, new_node)
                parent = dict.__getitem__(parent, part)
            dict.__setitem__(parent, parts[-1], val)
            return val

        # Navigate through nested dicts
        try:
            return _resolve_nested(self, parts)
        except KeyError:
            raise PDVKeyError(key)

    def __setitem__(self, key: str, value: Any) -> None:
        """Set a value by key or dot-separated path.

        Creates intermediate :class:`PDVTree` nodes as needed.
        Emits a ``pdv.tree.changed`` push notification.

        Parameters
        ----------
        key : str
            A plain key or dot-separated path.
        value : Any
            The value to store.
        """
        parts = _split_dot_path(key)
        # Determine change_type before modifying
        try:
            exists = key in self
        except Exception:
            exists = False
        change_type = "updated" if exists else "added"

        if len(parts) == 1:
            dict.__setitem__(self, key, value)
        else:
            current: PDVTree = self
            for part in parts[:-1]:
                if not dict.__contains__(current, part):
                    new_node = PDVTree()
                    new_node._lazy_registry = self._lazy_registry
                    dict.__setitem__(current, part, new_node)
                node = dict.__getitem__(current, part)
                if not isinstance(node, dict):
                    # Replace non-dict node with a PDVTree
                    new_node = PDVTree()
                    new_node._lazy_registry = self._lazy_registry
                    dict.__setitem__(current, part, new_node)
                    node = new_node
                current = node  # type: ignore[assignment]
            dict.__setitem__(current, parts[-1], value)

        self._emit_changed(key, change_type)

    def __delitem__(self, key: str) -> None:
        """Delete a value by key or dot-separated path.

        Removes from both in-memory storage and the lazy-load registry.
        Emits a ``pdv.tree.changed`` push notification.

        Parameters
        ----------
        key : str
            A plain key or dot-separated path.

        Raises
        ------
        PDVKeyError
            If the key does not exist in memory or in the lazy-load registry.
        """
        parts = _split_dot_path(key)
        in_registry = self._lazy_registry.has(key)

        if len(parts) == 1:
            p = parts[0]
            if not dict.__contains__(self, p) and not in_registry:
                raise PDVKeyError(key)
            if dict.__contains__(self, p):
                dict.__delitem__(self, p)
            if in_registry:
                self._lazy_registry._registry.pop(key, None)
        else:
            if in_registry:
                self._lazy_registry._registry.pop(key, None)
            try:
                parent: dict = self
                for part in parts[:-1]:
                    parent = dict.__getitem__(parent, part)
                if not dict.__contains__(parent, parts[-1]):
                    if not in_registry:
                        raise PDVKeyError(key)
                else:
                    dict.__delitem__(parent, parts[-1])
            except KeyError:
                if not in_registry:
                    raise PDVKeyError(key)

        self._emit_changed(key, "removed")

    def __contains__(self, key: object) -> bool:
        """Return True if key exists in memory or in the lazy-load registry."""
        if not isinstance(key, str):
            return False
        try:
            parts = _split_dot_path(key)
        except PDVPathError:
            return False
        if len(parts) == 1:
            return dict.__contains__(self, key) or self._lazy_registry.has(key)
        if self._lazy_registry.has(key):
            return True
        try:
            _resolve_nested(self, parts)
            return True
        except (KeyError, TypeError):
            return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run_script(self, script_path: str, **kwargs: Any) -> Any:
        """Execute a script stored in the tree.

        Resolves ``script_path`` to a :class:`PDVScript` node and calls
        ``script.run(self, **kwargs)``.

        Parameters
        ----------
        script_path : str
            Dot-separated path to the script node
            (e.g. ``'scripts.analysis.fit_model'``).
        **kwargs
            Forwarded to the script's ``run()`` function.

        Returns
        -------
        Any
            Return value of the script's ``run()`` function.

        Raises
        ------
        PDVKeyError
            If no node exists at ``script_path``.
        TypeError
            If the node at ``script_path`` is not a :class:`PDVScript`.
        PDVScriptError
            If the script raises during execution.
        """
        try:
            node = self[script_path]
        except PDVKeyError:
            raise PDVKeyError(script_path)
        if not isinstance(node, PDVScript):
            raise TypeError(
                f"Node at '{script_path}' is not a PDVScript (got {type(node).__name__})"
            )
        return node.run(self, **kwargs)

    def __repr__(self) -> str:
        keys = list(dict.keys(self))
        return f"PDVTree({keys})"
