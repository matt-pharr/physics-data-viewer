"""
pdv.tree — PDVTree, PDVFile, PDVScript, PDVNote, PDVGui, and PDVModule data structures.

This module is the core of the pdv package. It implements:

- :class:`PDVTree`: a dict subclass that is the live project data tree.
  It supports dot-path access and emits ``pdv.tree.changed`` push
  notifications on mutation (when a comm is attached).

- :class:`PDVFile`: base class for file-backed tree nodes. Provides shared
  UUID-based storage and ``resolve_path()`` for consistent path
  resolution across all file-backed node types.

- :class:`PDVScript`: a lightweight wrapper for a script file stored as
  a tree node. Subclass of ``PDVFile``.

- :class:`PDVNote`: a lightweight wrapper for a markdown note file stored
  as a tree node. Subclass of ``PDVFile``.

Design decisions recorded in ARCHITECTURE.md §5.6, §5.7, §5.8, §7.

This module has NO dependency on IPython, comms, or any Electron-facing
code. It can be imported and tested standalone.
"""

from __future__ import annotations

import inspect
import importlib.metadata
import importlib.util
import re
import os
import sys
import threading
from typing import Any, Callable, TypedDict

from pdv.errors import PDVKeyError, PDVPathError, PDVScriptError


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


def _reset_script_module_cache(prefix: str, file_path: str) -> str:
    """Build a unique synthetic module name and clear any stale cache entry.

    Used by both :func:`_extract_script_params` and :meth:`PDVScript.run` to
    re-import a script file fresh, bypassing Python's import cache so that
    in-place edits to the script file are always reflected.

    Parameters
    ----------
    prefix : str
        Internal prefix used to namespace the synthetic module names so
        that signature-extraction and execution caches do not collide
        (``"_pdv_script_params"`` vs ``"_pdv_script"``).
    file_path : str
        Absolute path to the script file. Hashed to derive a stable
        per-file module name.

    Returns
    -------
    str
        The synthetic module name to use with ``importlib.util``.
    """
    module_name = f"{prefix}_{abs(hash(file_path))}"
    if module_name in sys.modules:
        del sys.modules[module_name]
    return module_name


def _extract_script_params(file_path: str) -> list[ScriptParameter]:
    """Extract user-facing run() params from a script file.

    Returns an empty list if the file does not exist, cannot be parsed,
    or does not define a callable run() function.
    """
    if not os.path.exists(file_path):
        return []

    module_name = _reset_script_module_cache("_pdv_script_params", file_path)

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

    Provides shared UUID-based file storage and ``preview()`` interface
    used by both :class:`PDVScript` and :class:`PDVNote`, and any future
    file-backed node types (images, data files, etc.).

    Parameters
    ----------
    uuid : str
        12-hex-character UUID identifying this node's storage directory.
    filename : str
        Original filename including extension (e.g. ``'fit.py'``).
    source_rel_path : str or None
        For module-owned files, the path of this file relative to the
        **module root** (e.g. ``"scripts/run.py"`` or ``"lib/helpers.py"``)
        as it exists inside the pristine ``<saveDir>/modules/<id>/``
        directory. Used by the save-time sync step in
        ``handle_project_save`` so edits made in the working directory can
        be mirrored back to the project-local module copy. ``None`` for
        non-module files (ordinary project scripts, notes, etc.).

    See Also
    --------
    ARCHITECTURE.md §5.7, §5.13
    """

    def __init__(
        self,
        uuid: str,
        filename: str,
        source_rel_path: str | None = None,
    ) -> None:
        self._uuid = uuid
        self._filename = filename
        self._source_rel_path = source_rel_path

    @property
    def uuid(self) -> str:
        """12-hex-character UUID for this node's storage directory.

        Returns
        -------
        str
        """
        return self._uuid

    @property
    def filename(self) -> str:
        """Original filename including extension.

        Returns
        -------
        str
        """
        return self._filename

    @property
    def source_rel_path(self) -> str | None:
        """Path relative to the owning module's root, or ``None``.

        Returns
        -------
        str or None
            For module-owned files, the rel-path inside
            ``<saveDir>/modules/<id>/``. ``None`` for files that do not
            belong to a module.
        """
        return self._source_rel_path

    def resolve_path(self, working_dir: str | None = None) -> str:
        """Resolve the backing file to an absolute path.

        Computes ``<working_dir>/tree/<uuid>/<filename>``.

        Parameters
        ----------
        working_dir : str or None
            Working directory (or save directory) containing the
            ``tree/`` subdirectory. When ``None``, the current session's
            working directory is obtained from the global ``pdv_tree``.

        Returns
        -------
        str
            Absolute file path.

        Raises
        ------
        RuntimeError
            If no working directory is available (no argument and no
            active session).
        """
        if working_dir is None:
            from pdv.comms import get_pdv_tree  # noqa: PLC0415

            tree = get_pdv_tree()
            if tree is not None:
                working_dir = getattr(tree, "_working_dir", None)
        if working_dir is None:
            raise RuntimeError(
                "Cannot resolve file path: no working directory. "
                "Pass working_dir explicitly or ensure a PDV session is active."
            )
        return os.path.join(working_dir, "tree", self._uuid, self._filename)

    def preview(self) -> str:
        """Return a short human-readable preview for the tree panel.

        Returns
        -------
        str
            Preview string. Subclasses should override for domain-specific
            previews.
        """
        return self._filename

    def __repr__(self) -> str:
        cls = type(self).__name__
        return f"{cls}(uuid='{self._uuid}', filename='{self._filename}')"


class PDVScript(PDVFile):
    """
    Lightweight wrapper for a script file stored as a PDV tree node.

    Stored as the value at a tree path (e.g. ``pdv_tree['scripts.analysis.fit']``).
    Calling ``script.run(pdv_tree, **kwargs)`` loads the script module fresh
    (no cache) and calls its ``run(tree, **kwargs)`` function.

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        Script filename including extension (e.g. ``'fit.py'``).
    language : str
        Language of the script. Currently only ``'python'`` is supported.
    doc : str or None
        First line of the script's docstring, used as a preview. If None,
        extracted from the file automatically.

    See Also
    --------
    ARCHITECTURE.md §5.7
    """

    def __init__(
        self,
        uuid: str,
        filename: str,
        language: str = "python",
        doc: str | None = None,
        module_id: str = "",
        source_rel_path: str | None = None,
    ) -> None:
        super().__init__(uuid, filename, source_rel_path=source_rel_path)
        self._language = language
        self._doc = doc
        self._module_id = module_id

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

    # Regex matching PEP 508 "extra ==" markers (used to declare optional deps).
    _EXTRA_MARKER_RE = re.compile(r"extra\s*==")

    @staticmethod
    def _resolve_import_name(dist_name: str) -> str:
        """Map a pip distribution name to its top-level importable module name.

        Uses ``importlib.metadata`` when the package is installed, falling
        back to a small hardcoded map for well-known exceptions and then to
        the simple ``name.replace("-", "_")`` heuristic.
        """
        # Well-known exceptions where dist name diverges from import name.
        _known: dict[str, str] = {
            "pillow": "PIL",
            "scikit-learn": "sklearn",
            "opencv-python": "cv2",
            "pyyaml": "yaml",
        }
        key = dist_name.lower()
        if key in _known:
            return _known[key]
        try:
            top_level = importlib.metadata.distribution(dist_name).read_text(
                "top_level.txt"
            )
            if top_level:
                first = top_level.strip().split()[0]
                if first:
                    return first
        except (importlib.metadata.PackageNotFoundError, FileNotFoundError):
            pass
        return dist_name.replace("-", "_")

    def _check_module_dependencies(self, tree: "PDVTree") -> None:
        """Verify that the parent module's declared dependencies are importable.

        Searches top-level tree values for a :class:`PDVModule` whose
        ``module_id`` matches this script's ``_module_id``, then checks each
        non-optional dependency with :func:`importlib.util.find_spec`.

        Raises
        ------
        PDVScriptError
            When one or more required packages are missing.
        """
        parent_module: PDVModule | None = None
        for value in dict.values(tree):
            if isinstance(value, PDVModule) and value.module_id == self._module_id:
                parent_module = value
                break
        if parent_module is None or not parent_module.dependencies:
            return

        missing: list[str] = []
        for dep in parent_module.dependencies:
            name = dep.get("name", "")
            marker = dep.get("marker", "")
            if not name:
                continue
            # Skip optional dependencies: PEP 508 uses "extra == ..." markers.
            if marker and self._EXTRA_MARKER_RE.search(marker):
                continue
            import_name = self._resolve_import_name(name)
            if importlib.util.find_spec(import_name) is None:
                missing.append(name)

        if missing:
            raise PDVScriptError(
                f"Module '{parent_module.name}' requires packages not installed "
                f"in the active environment: {', '.join(missing)}"
            )

    def run(self, tree: "PDVTree" | None = None, **kwargs: Any) -> Any:
        """Load and execute the script, calling its ``run()`` function.

        Loads the module fresh on every call (no import cache). The
        script module must define a ``run(tree, **kwargs)`` function.

        Parameters
        ----------
        tree : PDVTree or None
            The live project data tree, passed as the first argument to
            the script's ``run()`` function. When omitted, the bootstrapped
            global tree from ``pdv.comms`` is used.
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
            from pdv.comms import get_pdv_tree  # noqa: PLC0415

            tree = get_pdv_tree()
            if tree is None:
                raise PDVScriptError("PDVTree is not initialized")

        working_dir = getattr(tree, "_working_dir", None)
        file_path = self.resolve_path(working_dir)

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Script file not found: {file_path}")

        # Pre-flight dependency check: if this script belongs to a module
        # with declared dependencies, verify they are importable before
        # running. This catches missing-package errors early with a clear
        # message instead of a cryptic ImportError mid-execution.
        if self._module_id and tree is not None:
            self._check_module_dependencies(tree)

        module_name = _reset_script_module_cache("_pdv_script", file_path)

        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec is None or spec.loader is None:
            raise PDVScriptError(f"Cannot load script: {file_path}")

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]

        if not hasattr(module, "run"):
            raise PDVScriptError(
                f"Script '{self._filename}' does not define a run() function"
            )

        try:
            return module.run(tree, **kwargs)
        except Exception as exc:
            raise PDVScriptError(
                f"Script '{self._filename}' raised during run(): {exc}"
            ) from exc

    def __repr__(self) -> str:
        return f"PDVScript(uuid='{self._uuid}', filename='{self._filename}', lang='{self._language}')"


# ---------------------------------------------------------------------------
# PDVGui
# ---------------------------------------------------------------------------


class PDVGui(PDVFile):
    """
    File-backed GUI definition node.

    Stored as the value at a tree path (e.g. ``pdv_tree['my_module.gui']``).
    Backed by a ``.gui.json`` file in the working directory.

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        GUI filename (e.g. ``'editor.gui.json'``).
    module_id : str or None
        Module identifier for module-owned GUIs. None for user-created project GUIs.
    """

    def __init__(
        self,
        uuid: str,
        filename: str,
        module_id: str | None = None,
        source_rel_path: str | None = None,
    ) -> None:
        super().__init__(uuid, filename, source_rel_path=source_rel_path)
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
        return f"PDVGui(uuid='{self._uuid}', filename='{self._filename}'{mid})"


class PDVNamelist(PDVFile):
    """
    File-backed namelist node. Knows its format for parsing dispatch.

    Stored as the value at a tree path (e.g. ``pdv_tree['module.solver_nml']``).
    Backed by a Fortran ``.in``/``.nml`` or TOML file.

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        Namelist filename (e.g. ``'solver.nml'``).
    format : str
        Namelist format: ``'fortran'``, ``'toml'``, or ``'auto'`` (detect from extension).
    module_id : str or None
        Module identifier for module-owned namelists. None for user-created namelists.

    See Also
    --------
    ARCHITECTURE.md §7.2
    """

    def __init__(
        self,
        uuid: str,
        filename: str,
        format: str = "auto",
        module_id: str | None = None,
        source_rel_path: str | None = None,
    ) -> None:
        super().__init__(uuid, filename, source_rel_path=source_rel_path)
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
        return f"PDVNamelist(uuid='{self._uuid}', filename='{self._filename}', format='{self._format}'{mid})"


class PDVLib(PDVFile):
    """
    File-backed Python library file provided by a module.

    Stored as the value at a tree path under ``<alias>.lib.*``.  The parent
    directory of the on-disk file is added to ``sys.path`` so that the module
    is importable from scripts and entry points.

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        Library filename (e.g. ``'n_pendulum.py'``). Preserved exactly
        so that ``import n_pendulum`` works.
    module_id : str or None
        Module identifier for the owning module.

    See Also
    --------
    ARCHITECTURE.md §5.10, §7.2
    """

    def __init__(
        self,
        uuid: str,
        filename: str,
        module_id: str | None = None,
        source_rel_path: str | None = None,
    ) -> None:
        super().__init__(uuid, filename, source_rel_path=source_rel_path)
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
        return f"Library ({self._filename})"

    def __repr__(self) -> str:
        mid = f", module_id='{self._module_id}'" if self._module_id else ""
        return f"PDVLib(uuid='{self._uuid}', filename='{self._filename}'{mid})"


class PDVNote(PDVFile):
    """
    Lightweight wrapper for a markdown file stored as a PDV tree node.

    Stored as the value at a tree path (e.g. ``pdv_tree['notes.intro']``).
    Backed by a ``.md`` file in the working directory.

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        Note filename (e.g. ``'intro.md'``).
    title : str or None
        Optional title for the note, used as a preview fallback. If None,
        the first non-empty line of the file is used.

    See Also
    --------
    ARCHITECTURE.md §7.2, PLANNED_FEATURES.md Feature 4
    """

    def __init__(self, uuid: str, filename: str, title: str | None = None) -> None:
        super().__init__(uuid, filename)
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
        return "Markdown note"


# ---------------------------------------------------------------------------
# PDVTree
# ---------------------------------------------------------------------------


class PDVTree(dict):
    """
    The live project data tree. The sole authority on all project data.

    A dict subclass that supports:

    - Dot-path access: ``pdv_tree['data.waveforms.ch1']``
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

    _DEBOUNCE_INTERVAL = 0.1  # seconds

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._working_dir: str | None = None
        self._save_dir: str | None = None
        self._send_fn: Callable[[str, dict], None] | None = None
        self._pending_changes: list[tuple[str, str]] = []
        self._debounce_timer: threading.Timer | None = None
        self._debounce_lock = threading.Lock()

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
        """Queue a change notification and schedule a debounced flush.

        Notifications are accumulated and sent as a single batch after
        ``_DEBOUNCE_INTERVAL`` seconds of inactivity.  This prevents
        flooding the comm channel during tight mutation loops.

        Parameters
        ----------
        path : str
            The dot-separated path that changed.
        change_type : str
            One of ``'added'``, ``'removed'``, or ``'updated'``.
        """
        if self._send_fn is None:
            return
        with self._debounce_lock:
            self._pending_changes.append((path, change_type))
            if self._debounce_timer is not None:
                self._debounce_timer.cancel()
            self._debounce_timer = threading.Timer(
                self._DEBOUNCE_INTERVAL, self._flush_changes
            )
            self._debounce_timer.daemon = True
            self._debounce_timer.start()

    def _flush_changes(self) -> None:
        """Send all pending change notifications as a single batch.

        Deduplicates by path, keeping the last change_type per path.
        Called automatically by the debounce timer, or manually in tests.
        """
        with self._debounce_lock:
            pending = self._pending_changes
            self._pending_changes = []
            self._debounce_timer = None
            send_fn = (
                self._send_fn
            )  # capture under lock to avoid race with _detach_comm
        if not pending or send_fn is None:
            return
        # Deduplicate: last change_type per path wins.
        seen: dict[str, str] = {}
        for path, change_type in pending:
            seen[path] = change_type
        send_fn(
            "pdv.tree.changed",
            {"changed_paths": list(seen.keys()), "change_type": "batch"},
        )

    # ------------------------------------------------------------------
    # dict overrides
    # ------------------------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        """Get a value by key or dot-separated path.

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
            If the key does not exist.
        """
        parts = _split_dot_path(key)

        if len(parts) == 1:
            p = parts[0]
            if dict.__contains__(self, p):
                return dict.__getitem__(self, p)
            raise PDVKeyError(key)

        try:
            return _resolve_nested(self, parts)
        except KeyError:
            raise PDVKeyError(key)

    def set_quiet(self, key: str, value: Any) -> None:
        """Set a value at a dot-path without emitting notifications.

        Used by bulk loaders (project load, module register) to populate the
        tree without flooding the comm channel with per-node ``pdv.tree.changed``
        events. Uses the same dot-path traversal and "replace non-dict
        intermediate" branch as :meth:`__setitem__`.

        After bulk loading completes, callers typically emit a single
        ``pdv.project.loaded`` push so renderers know to refetch.

        Parameters
        ----------
        key : str
            A plain key or dot-separated path.
        value : Any
            The value to store.
        """
        parts = _split_dot_path(key)
        if len(parts) == 1:
            dict.__setitem__(self, key, value)
            return
        current: PDVTree = self
        for part in parts[:-1]:
            if not dict.__contains__(current, part):
                new_node = PDVTree()
                dict.__setitem__(current, part, new_node)
            node = dict.__getitem__(current, part)
            if not isinstance(node, dict):
                # Replace non-dict node with a PDVTree
                new_node = PDVTree()
                dict.__setitem__(current, part, new_node)
                node = new_node
            current = node  # type: ignore[assignment]
        dict.__setitem__(current, parts[-1], value)

    def __setitem__(self, key: str, value: Any) -> None:
        """Set a value by key or dot-separated path.

        Creates intermediate :class:`PDVTree` nodes as needed.
        Emits a ``pdv.tree.changed`` push notification for the leaf path
        **and for any intermediate containers that are newly created
        (or replaced) as a side effect**, so renderers that rely on
        changed_paths to know what to refetch see every mutation.

        Parameters
        ----------
        key : str
            A plain key or dot-separated path.
        value : Any
            The value to store.
        """
        parts = _split_dot_path(key)

        # Walk the existing tree to find which prefix paths will be
        # newly created (or replaced, in the "non-dict intermediate"
        # branch of set_quiet). Once we hit the first missing/non-dict
        # segment, every deeper intermediate prefix is also new.
        added_prefixes: list[str] = []
        current: dict = self
        for i in range(len(parts) - 1):
            part = parts[i]
            needs_create = not dict.__contains__(current, part) or not isinstance(
                dict.__getitem__(current, part), dict
            )
            if needs_create:
                for j in range(i, len(parts) - 1):
                    added_prefixes.append(".".join(parts[: j + 1]))
                break
            current = dict.__getitem__(current, part)

        try:
            exists = key in self
        except Exception:
            exists = False
        change_type = "updated" if exists else "added"
        self.set_quiet(key, value)

        # Ancestors first so renderers can refresh top-down.
        for prefix in added_prefixes:
            self._emit_changed(prefix, "added")
        self._emit_changed(key, change_type)

    def __delitem__(self, key: str) -> None:
        """Delete a value by key or dot-separated path.

        Emits a ``pdv.tree.changed`` push notification.

        Parameters
        ----------
        key : str
            A plain key or dot-separated path.

        Raises
        ------
        PDVKeyError
            If the key does not exist.
        """
        parts = _split_dot_path(key)

        if len(parts) == 1:
            p = parts[0]
            if not dict.__contains__(self, p):
                raise PDVKeyError(key)
            dict.__delitem__(self, p)
        else:
            try:
                parent: dict = self
                for part in parts[:-1]:
                    parent = dict.__getitem__(parent, part)
                if not dict.__contains__(parent, parts[-1]):
                    raise PDVKeyError(key)
                dict.__delitem__(parent, parts[-1])
            except KeyError:
                raise PDVKeyError(key)

        self._emit_changed(key, "removed")

    def __contains__(self, key: object) -> bool:
        """Return True if key exists in the tree."""
        if not isinstance(key, str):
            return False
        try:
            parts = _split_dot_path(key)
        except PDVPathError:
            return False
        if len(parts) == 1:
            return dict.__contains__(self, key)
        try:
            _resolve_nested(self, parts)
            return True
        except (KeyError, TypeError):
            return False

    # ------------------------------------------------------------------
    # Mutating dict methods — route through overrides to emit notifications
    # ------------------------------------------------------------------
    # Note: these only emit notifications when called on the *root* PDVTree
    # (which has a _send_fn attached).  Sub-dicts accessed via
    # ``pdv_tree['path']`` are plain PDVTree instances without a comm, so
    # mutations on them are silent.  The recommended pattern is always to
    # use dot-path access through the root, e.g. ``pdv_tree.pop('a.b')``.

    def pop(self, key: str, *args: Any) -> Any:
        """Remove and return value at *key*, emitting a change notification.

        Supports dot-separated paths.  Accepts an optional default that is
        returned (without notification) when *key* is missing.
        """
        if len(args) > 1:
            raise TypeError(f"pop expected at most 2 arguments, got {1 + len(args)}")
        parts = _split_dot_path(key)
        if len(parts) == 1:
            if not dict.__contains__(self, key):
                if args:
                    return args[0]
                raise PDVKeyError(key)
            value = dict.pop(self, key)
        else:
            try:
                parent: dict = self
                for part in parts[:-1]:
                    parent = dict.__getitem__(parent, part)
                if not dict.__contains__(parent, parts[-1]):
                    if args:
                        return args[0]
                    raise PDVKeyError(key)
                value = dict.pop(parent, parts[-1])
            except KeyError:
                if args:
                    return args[0]
                raise PDVKeyError(key)
        self._emit_changed(key, "removed")
        return value

    def update(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        """Merge key/value pairs, emitting a notification for each key."""
        if len(args) > 1:
            raise TypeError(f"update expected at most 1 argument, got {len(args)}")
        if args:
            other = args[0]
            if hasattr(other, "keys"):
                for k in other.keys():
                    self[k] = other[k]
            else:
                for k, v in other:
                    self[k] = v
        for k, v in kwargs.items():
            self[k] = v

    def clear(self) -> None:
        """Remove all keys, emitting a removal notification for each."""
        keys = list(dict.keys(self))
        dict.clear(self)
        for key in keys:
            self._emit_changed(key, "removed")

    def setdefault(self, key: str, default: Any = None) -> Any:
        """Get *key* if present, otherwise set it to *default* and notify."""
        if key not in self:
            self[key] = default  # routes through __setitem__
        return self[key]

    def __ior__(self, other: Any) -> "PDVTree":
        """Support ``tree |= other`` with change notifications (Python 3.9+)."""
        self.update(other)
        return self

    def popitem(self) -> tuple:
        """Remove and return an arbitrary ``(key, value)`` pair with notification."""
        key, value = dict.popitem(self)
        self._emit_changed(key, "removed")
        return key, value

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


class PDVModule(PDVTree):
    """
    Module metadata node. PDVTree subclass so it can hold children naturally
    and participate in dot-path access and change notifications.

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
    description : str, optional
        Longer human-readable description. Persisted into ``pdv-module.json``
        at export time for workflow B (create empty → author → export).
    language : str, optional
        Kernel language (``"python"`` or ``"julia"``). Defaults to
        ``"python"``. Also persisted into ``pdv-module.json`` at export.

    See Also
    --------
    ARCHITECTURE.md §5.9, and the #140 module editing workflow plan §5.
    """

    def __init__(
        self,
        module_id: str,
        name: str,
        version: str,
        gui: PDVGui | None = None,
        dependencies: list[dict[str, str]] | None = None,
        description: str = "",
        language: str = "python",
    ) -> None:
        super().__init__()
        self._module_id = module_id
        self._name = name
        self._version = version
        self._gui = gui
        self._dependencies: list[dict[str, str]] = dependencies or []
        self._description = description
        self._language = language

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

    @name.setter
    def name(self, value: str) -> None:
        """Update the human-readable module name.

        Workflow B exposes this via the in-app metadata editor so users
        can rename a freshly-created empty module without editing JSON.
        """
        self._name = value

    @property
    def version(self) -> str:
        """Semantic version string.

        Returns
        -------
        str
        """
        return self._version

    @version.setter
    def version(self, value: str) -> None:
        """Update the module's semver string.

        Mutable so the in-app metadata editor can bump versions.
        """
        self._version = value

    @property
    def description(self) -> str:
        """Longer human-readable description, or empty string.

        Returns
        -------
        str
        """
        return self._description

    @description.setter
    def description(self, value: str) -> None:
        self._description = value

    @property
    def language(self) -> str:
        """Kernel language used by this module.

        Returns
        -------
        str
            ``"python"`` or ``"julia"``.
        """
        return self._language

    @property
    def dependencies(self) -> list[dict[str, str]]:
        """Declared module dependencies (read-only).

        Returns
        -------
        list[dict[str, str]]
        """
        return self._dependencies

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
