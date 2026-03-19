"""
pdv_kernel.tree — PDVTree, PDVFile, PDVScript, PDVNote, PDVGui, and PDVModule data structures.

This module is the core of the pdv_kernel package. It implements:

- :class:`PDVTree`: a dict subclass that is the live project data tree.
  It supports dot-path access, a lazy-load registry for data backed by
  the project save directory, and emits ``pdv.tree.changed`` push
  notifications on mutation (when a comm is attached).

- :class:`PDVFile`: base class for file-backed tree nodes. Provides shared
  ``relative_path`` storage and ``resolve_path()`` for consistent path
  resolution across all file-backed node types.

- :class:`PDVScript`: a lightweight wrapper for a script file stored as
  a tree node. Subclass of ``PDVFile``.

- :class:`PDVNote`: a lightweight wrapper for a markdown note file stored
  as a tree node. Subclass of ``PDVFile``.

- :class:`LazyLoadRegistry`: internal registry mapping tree paths to
  save-directory storage references. Not user-accessible.

Design decisions recorded in ARCHITECTURE.md §5.6, §5.7, §5.8, §7.

This module has NO dependency on IPython, comms, or any Electron-facing
code. It can be imported and tested standalone.
"""

from __future__ import annotations

import inspect
import importlib.util
import os
import sys
from typing import Any, Callable, TypedDict

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
        """Return whether a lazy-load entry exists for a path.

        Parameters
        ----------
        path : str
            Dot-separated tree path.

        Returns
        -------
        bool
            True when the path is currently registered for lazy loading.
        """
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
        return deserialize_node(storage_ref, save_dir, trusted=True)

    def get_storage(self, path: str) -> dict | None:
        """Return the registered storage reference for a path, if present.

        Parameters
        ----------
        path : str
            Dot-separated tree path.

        Returns
        -------
        dict | None
            Storage reference dict when registered, else ``None``.
        """
        return self._registry.get(path)

    def remove(self, path: str) -> None:
        """Remove one registry entry if present.

        Parameters
        ----------
        path : str
            Dot-separated tree path to remove.
        """
        self._registry.pop(path, None)

    def entries(self) -> list[tuple[str, dict]]:
        """Return a snapshot of all lazy registry entries.

        Returns
        -------
        list[tuple[str, dict]]
            List of ``(path, storage_ref)`` pairs.
        """
        return list(self._registry.items())

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


class ScriptParameter(TypedDict):
    """Descriptor for one user-facing PDVScript run() parameter."""

    name: str
    type: str
    default: Any
    required: bool


def _annotation_to_type_name(annotation: Any) -> str:
    """Convert a Python annotation object to a stable string label."""
    if annotation is inspect.Parameter.empty:
        return "any"
    if isinstance(annotation, str):
        return annotation
    if hasattr(annotation, "__name__"):
        return str(annotation.__name__)
    return str(annotation)


def _extract_script_params(file_path: str) -> list[ScriptParameter]:
    """Extract user-facing run() params from a script file.

    Returns an empty list if the file does not exist, cannot be parsed,
    or does not define a callable run() function.
    """
    if not os.path.exists(file_path):
        return []

    module_name = f"_pdv_script_params_{abs(hash(file_path))}"
    if module_name in sys.modules:
        del sys.modules[module_name]

    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        return []

    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except (SyntaxError, FileNotFoundError, OSError, ImportError):
        return []

    run_fn = getattr(module, "run", None)
    if not callable(run_fn):
        return []

    try:
        signature = inspect.signature(run_fn)
    except (TypeError, ValueError):
        return []

    extracted: list[ScriptParameter] = []
    for index, (param_name, param) in enumerate(signature.parameters.items()):
        if index == 0:
            continue
        if param.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        has_default = param.default is not inspect.Parameter.empty
        extracted.append(
            {
                "name": param_name,
                "type": _annotation_to_type_name(param.annotation),
                "default": param.default if has_default else None,
                "required": not has_default,
            }
        )
    return extracted

# ---------------------------------------------------------------------------
# PDVFile — base class for file-backed tree nodes
# ---------------------------------------------------------------------------

class PDVFile:
    """
    Base class for file-backed PDV tree nodes.

    Provides shared ``relative_path`` storage and ``preview()`` interface
    used by both :class:`PDVScript` and :class:`PDVNote`, and any future
    file-backed node types (images, data files, etc.).

    Parameters
    ----------
    relative_path : str
        Path to the backing file (absolute or relative to working dir).

    See Also
    --------
    ARCHITECTURE.md §5.7
    """

    def __init__(self, relative_path: str) -> None:
        self._relative_path = relative_path

    @property
    def relative_path(self) -> str:
        """Path to the backing file.

        Returns
        -------
        str
            File path (absolute or relative to working dir).
        """
        return self._relative_path

    def resolve_path(self, working_dir: str | None = None) -> str:
        """Resolve the backing file to an absolute path.

        Parameters
        ----------
        working_dir : str or None
            Working directory to resolve relative paths against.

        Returns
        -------
        str
            Absolute file path.
        """
        if os.path.isabs(self._relative_path):
            return self._relative_path
        if working_dir:
            return os.path.join(working_dir, self._relative_path)
        return self._relative_path

    def preview(self) -> str:
        """Return a short human-readable preview for the tree panel.

        Returns
        -------
        str
            Preview string. Subclasses should override for domain-specific
            previews.
        """
        return os.path.basename(self._relative_path)

    def __repr__(self) -> str:
        cls = type(self).__name__
        return f"{cls}('{self._relative_path}')"


class PDVScript(PDVFile):
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
        super().__init__(relative_path)
        self._language = language
        self._doc = doc
        self._params: list[ScriptParameter] = _extract_script_params(relative_path)

    @property
    def language(self) -> str:
        """Script language. Currently always ``'python'``.

        Returns
        -------
        str
            Script language identifier.
        """
        return self._language

    @property
    def doc(self) -> str | None:
        """First line of the script docstring, or None.

        Returns
        -------
        str or None
            Cached script doc preview line.
        """
        return self._doc

    @property
    def params(self) -> list[ScriptParameter]:
        """User-facing run() parameters (excluding pdv_tree).

        Returns
        -------
        list[ScriptParameter]
            Extracted script parameter descriptors.
        """
        return self._params

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

    def run(self, tree: "PDVTree" | None = None, **kwargs: Any) -> Any:
        """Load and execute the script, calling its ``run()`` function.

        Loads the module fresh on every call (no import cache). The
        script module must define a ``run(tree, **kwargs)`` function.

        Parameters
        ----------
        tree : PDVTree or None
            The live project data tree, passed as the first argument to
            the script's ``run()`` function. When omitted, the bootstrapped
            global tree from ``pdv_kernel.comms`` is used.
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
            If the script has no ``run()`` function, if no tree is available,
            or if ``run()`` raises.
        """
        if tree is None:
            from pdv_kernel.comms import get_pdv_tree  # noqa: PLC0415

            tree = get_pdv_tree()
            if tree is None:
                raise PDVScriptError("PDVTree is not initialized")

        working_dir = getattr(tree, "_working_dir", None)
        file_path = self.resolve_path(working_dir)

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
# PDVNote
# ---------------------------------------------------------------------------

class PDVGui(PDVFile):
    """
    File-backed GUI definition node.

    Stored as the value at a tree path (e.g. ``pdv_tree['my_module.gui']``).
    Backed by a ``.gui.json`` file in the working directory.

    Parameters
    ----------
    relative_path : str
        Path to the ``.gui.json`` file (absolute or relative to working dir).
    module_id : str or None
        Module identifier for module-owned GUIs. None for user-created project GUIs.
    """

    def __init__(self, relative_path: str, module_id: str | None = None) -> None:
        super().__init__(relative_path)
        self._module_id = module_id

    @property
    def module_id(self) -> str | None:
        """Module identifier, or None for project-level GUIs.

        Returns
        -------
        str or None
            The module id this GUI belongs to.
        """
        return self._module_id

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Returns
        -------
        str
            Always ``'GUI'``.
        """
        return "GUI"

    def __repr__(self) -> str:
        mid = f", module_id='{self._module_id}'" if self._module_id else ""
        return f"PDVGui('{self._relative_path}'{mid})"


class PDVNamelist(PDVFile):
    """
    File-backed namelist node. Knows its format for parsing dispatch.

    Stored as the value at a tree path (e.g. ``pdv_tree['module.solver_nml']``).
    Backed by a Fortran ``.in``/``.nml`` or TOML file.

    Parameters
    ----------
    relative_path : str
        Path to the backing namelist file (absolute or relative to working dir).
    format : str
        Namelist format: ``'fortran'``, ``'toml'``, or ``'auto'`` (detect from extension).
    module_id : str or None
        Module identifier for module-owned namelists. None for user-created namelists.

    See Also
    --------
    ARCHITECTURE.md §7.2
    """

    def __init__(self, relative_path: str, format: str = "auto",
                 module_id: str | None = None) -> None:
        super().__init__(relative_path)
        self._format = format  # "fortran", "toml", "auto"
        self._module_id = module_id

    @property
    def format(self) -> str:
        """Namelist format: ``'fortran'``, ``'toml'``, or ``'auto'``.

        Returns
        -------
        str
        """
        return self._format

    @property
    def module_id(self) -> str | None:
        """Module identifier, or None for user-created namelists.

        Returns
        -------
        str or None
        """
        return self._module_id

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Returns
        -------
        str
        """
        return f"Namelist ({self._format})"

    def __repr__(self) -> str:
        mid = f", module_id='{self._module_id}'" if self._module_id else ""
        return f"PDVNamelist('{self._relative_path}', format='{self._format}'{mid})"


class PDVLib(PDVFile):
    """
    File-backed Python library file provided by a module.

    Stored as the value at a tree path under ``<alias>.lib.*``.  The parent
    directory of the on-disk file is added to ``sys.path`` so that the module
    is importable from scripts and entry points.

    Parameters
    ----------
    relative_path : str
        Path to the ``.py`` file (absolute or relative to working dir).
    module_id : str or None
        Module identifier for the owning module.

    See Also
    --------
    ARCHITECTURE.md §5.10, §7.2
    """

    def __init__(self, relative_path: str, module_id: str | None = None) -> None:
        super().__init__(relative_path)
        self._module_id = module_id

    @property
    def module_id(self) -> str | None:
        """Module identifier, or None.

        Returns
        -------
        str or None
        """
        return self._module_id

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Returns
        -------
        str
        """
        return f"Library ({os.path.basename(self._relative_path)})"

    def __repr__(self) -> str:
        mid = f", module_id='{self._module_id}'" if self._module_id else ""
        return f"PDVLib('{self._relative_path}'{mid})"


class PDVNote(PDVFile):
    """
    Lightweight wrapper for a markdown file stored as a PDV tree node.

    Stored as the value at a tree path (e.g. ``pdv_tree['notes.intro']``).
    Backed by a ``.md`` file in the working directory.

    Parameters
    ----------
    relative_path : str
        Path to the ``.md`` file (absolute or relative to working dir).
    title : str or None
        Optional title for the note, used as a preview fallback. If None,
        the first non-empty line of the file is used.

    See Also
    --------
    ARCHITECTURE.md §7.2, PLANNED_FEATURES.md Feature 4
    """

    def __init__(self, relative_path: str, title: str | None = None) -> None:
        super().__init__(relative_path)
        self._title = title

    @property
    def title(self) -> str | None:
        """Optional title for the note.

        Returns
        -------
        str or None
            Cached title, or None if not set.
        """
        return self._title

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Tries the cached title first, then reads the first non-empty
        line of the ``.md`` file. Falls back to ``'Markdown note'``.

        Returns
        -------
        str
            A short preview string (≤100 characters).
        """
        if self._title:
            return self._title[:100]
        try:
            path = self._relative_path
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as fh:
                    for line in fh:
                        stripped = line.strip().lstrip("#").strip()
                        if stripped:
                            return stripped[:100]
        except Exception:  # noqa: BLE001
            pass
        return "Markdown note"


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
        self._path_prefix: str = ""

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

        # Build the full registry key (accounts for sub-trees with a path prefix)
        full_key = f"{self._path_prefix}.{key}" if self._path_prefix else key

        if len(parts) == 1:
            p = parts[0]
            if dict.__contains__(self, p):
                return dict.__getitem__(self, p)
            if self._lazy_registry.has(full_key):
                val = self._lazy_registry.fetch(full_key, self._save_dir or "")
                dict.__setitem__(self, p, val)
                return val
            raise PDVKeyError(key)

        # Multi-part: check the full path in the lazy registry first
        if self._lazy_registry.has(full_key):
            val = self._lazy_registry.fetch(full_key, self._save_dir or "")
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
                self._lazy_registry.remove(key)
        else:
            if in_registry:
                self._lazy_registry.remove(key)
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

    def has_lazy_entry(self, path: str) -> bool:
        """Return whether a path is currently registered for lazy loading."""
        return self._lazy_registry.has(path)

    def lazy_storage_for(self, path: str) -> dict | None:
        """Return the lazy storage reference for one path, if present."""
        return self._lazy_registry.get_storage(path)

    def iter_lazy_entries(self) -> list[tuple[str, dict]]:
        """Return a snapshot of all currently registered lazy paths."""
        return self._lazy_registry.entries()

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


class PDVModule(PDVTree):
    """
    Module metadata node. PDVTree subclass so it can hold children naturally
    and participate in dot-path access, lazy loading, and change notifications.

    Stored as the value at a tree path (e.g. ``pdv_tree['n_pendulum']``).
    Contains child entries like scripts folder and gui node as regular dict items.

    Parameters
    ----------
    module_id : str
        Unique module identifier.
    name : str
        Human-readable module name.
    version : str
        Semantic version string.
    gui : PDVGui or None
        Optional GUI definition node attached to this module.
    """

    def __init__(self, module_id: str, name: str, version: str,
                 gui: PDVGui | None = None) -> None:
        super().__init__()
        self._module_id = module_id
        self._name = name
        self._version = version
        self._gui = gui

    @property
    def module_id(self) -> str:
        """Unique module identifier.

        Returns
        -------
        str
        """
        return self._module_id

    @property
    def name(self) -> str:
        """Human-readable module name.

        Returns
        -------
        str
        """
        return self._name

    @property
    def version(self) -> str:
        """Semantic version string.

        Returns
        -------
        str
        """
        return self._version

    @property
    def gui(self) -> PDVGui | None:
        """Optional GUI definition node.

        Returns
        -------
        PDVGui or None
        """
        return self._gui

    @gui.setter
    def gui(self, value: PDVGui | None) -> None:
        self._gui = value

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Returns
        -------
        str
            Module name and version.
        """
        return f"{self._name} v{self._version}"

    def __repr__(self) -> str:
        return f"PDVModule('{self._module_id}', '{self._name}', '{self._version}')"
