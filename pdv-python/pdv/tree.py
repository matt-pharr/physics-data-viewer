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

import ast
import importlib.metadata
import importlib.util
import re
import os
import sys
import threading
from typing import Any, Callable, TypedDict

from pdv.errors import PDVError, PDVKeyError, PDVPathError, PDVScriptError


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
    """Recursively resolve a list of path parts through nested containers.

    Descends through nested dicts using string keys. When the current value
    is a ``list`` or ``tuple``, the next path part is interpreted as an
    integer index (so ``tree['waveforms.0.t']`` resolves to the ``'t'``
    field of the first waveform when ``waveforms`` is a list of dicts).
    Negative indices are supported (``tree['xs.-1']`` returns the last
    element) since ``int('-n')`` parses and Python's sequence indexing
    accepts negatives natively. Any other value with a virtual-children
    adapter (live ``xarray.Dataset``, ``h5py.Group``, file-backed
    ``PDVDataset``/``PDVHdf5`` nodes — see :mod:`pdv.virtual`) resolves
    the next part through ``adapter.child``, so dot-paths descend into
    those containers to arbitrary depth.

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
        If any part is not found at its level, or if a numeric index is
        out of range / non-integer where a list or tuple is expected.
    """
    from pdv.virtual import get_virtual_adapter  # noqa: PLC0415

    current: Any = obj
    for part in parts:
        if isinstance(current, dict):
            current = dict.__getitem__(current, part)
        elif isinstance(current, (list, tuple)):
            try:
                index = int(part)
            except ValueError:
                raise KeyError(part) from None
            try:
                current = current[index]
            except IndexError:
                raise KeyError(part) from None
        else:
            adapter = get_virtual_adapter(current)
            if adapter is None:
                raise KeyError(part)
            try:
                current = adapter.child(current, part)
            except KeyError:
                raise KeyError(part) from None
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


def _annotation_source(annotation: "ast.expr | None") -> str:
    """Render a parsed annotation node as a stable string label.

    ``None`` (no annotation) becomes ``"any"``; string annotations lose
    their quotes (``"int"`` → ``int``); everything else is the annotation's
    source text via ``ast.unparse`` (``np.ndarray`` stays dotted).
    """
    if annotation is None:
        return "any"
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        return annotation.value
    try:
        return ast.unparse(annotation)
    except Exception:  # noqa: BLE001
        return "any"


def _default_source(default: "ast.expr | None") -> Any:
    """Recover a parameter's default value from its parsed expression.

    Literals evaluate to their real value via ``ast.literal_eval``.
    Non-literal defaults (names, calls, attribute lookups like ``np.pi``)
    fall back to their source text — evaluating them would require
    importing the script, which is exactly what the AST parser exists to
    avoid. Returns ``None`` when there is no default.
    """
    if default is None:
        return None
    try:
        return ast.literal_eval(default)
    except (ValueError, SyntaxError):
        try:
            return ast.unparse(default)
        except Exception:  # noqa: BLE001
            return None


def _reset_script_module_cache(prefix: str, file_path: str) -> str:
    """Build a unique synthetic module name and clear any stale cache entry.

    Used by :meth:`PDVScript.run` to re-import a script file fresh,
    bypassing Python's import cache so that in-place edits to the script
    file are always reflected.

    Parameters
    ----------
    prefix : str
        Internal prefix used to namespace the synthetic module names
        (``"_pdv_script"``).
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
    """Extract user-facing run() params from a script file, without importing it.

    Parses the source with :mod:`ast` rather than importing the module.
    The previous import-based implementation executed the script's entire
    top-level code — side effects and all — every time the UI asked for
    parameters via ``pdv.script.params``, and only caught a narrow set of
    exceptions. Parsing is side-effect-free and fast.

    Literal default values are recovered as real Python values; non-literal
    defaults (e.g. ``scale=np.pi``) fall back to their source text — see
    :func:`_default_source`.

    Returns an empty list if the file does not exist, cannot be parsed,
    or does not define a top-level ``run()`` function.
    """
    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except OSError:
        return []
    try:
        parsed = ast.parse(source, filename=file_path)
    except (SyntaxError, ValueError):
        return []

    run_def = next(
        (
            node
            for node in parsed.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "run"
        ),
        None,
    )
    if run_def is None:
        return []

    args = run_def.args
    positional = [*args.posonlyargs, *args.args]
    # ast stores defaults right-aligned against the positional list.
    pos_defaults: list = [None] * (len(positional) - len(args.defaults)) + list(
        args.defaults
    )

    extracted: list[ScriptParameter] = []

    def _append(arg: ast.arg, default: "ast.expr | None") -> None:
        extracted.append(
            {
                "name": arg.arg,
                "type": _annotation_source(arg.annotation),
                "default": _default_source(default),
                "required": default is None,
            }
        )

    for index, (arg, default) in enumerate(zip(positional, pos_defaults)):
        if index == 0:
            continue  # pdv_tree — injected by PDVScript.run(), not user-facing
        _append(arg, default)
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        _append(arg, default)
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
            The first line of the docstring, or empty string when the
            script has no docstring (the chip already says ``script``).
        """
        if self._doc:
            return self._doc.split("\n")[0]
        return ""

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

        Returns empty string — the chip already says ``gui`` and the
        key column already shows the user-chosen name. There's no
        additional info worth surfacing here.
        """
        return ""

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

        Returns the namelist format only; the chip already says
        ``namelist``, so prefixing it again would be redundant.
        """
        return self._format

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

        Returns the filename only; the chip already says ``lib``,
        so prefixing it again would be redundant.
        """
        return self._filename

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

        Returns the cached title (or empty string when there is no
        title — the chip already says ``note``).

        Returns
        -------
        str
            A short preview string (≤100 characters).
        """
        if self._title:
            return self._title[:100]
        return ""


# ---------------------------------------------------------------------------
# PDVDataset / PDVHdf5 — lazy scientific data file nodes
# ---------------------------------------------------------------------------


# Serializes opens of scientific data files. xarray's and h5py's first
# import/open paths are not guaranteed thread-safe, and tree listings can
# arrive on the QueryServer thread while user code touches the same node
# on the main thread.
_DATA_FILE_OPEN_LOCK = threading.Lock()


def _dep_error_message(cls_name: str, missing: list[str], extra: str) -> str:
    """Build the actionable missing-dependency message for data file nodes.

    Parameters
    ----------
    cls_name : str
        User-facing class name (``'PDVDataset'`` / ``'PDVHdf5'``).
    missing : list[str]
        Missing pip package names.
    extra : str
        The pdv-python extras group that provides them.

    Returns
    -------
    str
        A message naming both ``pdv.install(...)`` and the pip extra.
    """
    pkgs = ", ".join(missing)
    install_args = ", ".join(f"'{pkg}'" for pkg in missing)
    return (
        f"{cls_name} requires packages not installed in the active "
        f"environment: {pkgs}. Install with pdv.install({install_args}) "
        f"or pip install 'pdv-python[{extra}]'"
    )


class PDVDataset(PDVFile):
    """
    Lazy tree node wrapping an xarray-compatible NetCDF file.

    Stored as the value at a tree path (e.g. ``pdv_tree['gpec.output']``).
    The backing file is copied into UUID storage at import time and then
    **never fully loaded**: the dataset is opened lazily (read-only) on
    first access, xarray pages variable data from disk on demand, and the
    tree panel lists variables/coordinates straight from the file header.
    Save copies the file as-is.

    Access from Python code returns live xarray objects::

        pdv_tree['gpec.output']['Phi'].sel(m=5).plot()
        pdv_tree['gpec.output.Phi']          # dot-path descent works too

    The node is read-only by design: to modify data, load a variable into
    memory (e.g. ``arr = node['Phi'].load()``), transform it, and store
    the result at a normal tree path.

    Requires the optional dependencies ``xarray`` plus a NetCDF backend
    engine (``netcdf4``, ``h5netcdf``, or ``scipy``) — checked when the
    file is first opened, *not* at construction, so projects containing
    these nodes always load.

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        Data filename (e.g. ``'gpec_output.nc'``).
    source_rel_path : str or None
        Module-relative source path, or None for ordinary project files.

    See Also
    --------
    PDVHdf5 : the general-HDF5 sibling node type.
    ARCHITECTURE.md §7.2
    """

    #: pip packages that can serve as the xarray NetCDF backend engine,
    #: with their importable module names (find_spec is case-sensitive).
    _ENGINE_MODULES = (("netcdf4", "netCDF4"), ("h5netcdf", "h5netcdf"),
                      ("scipy", "scipy"))

    def __init__(
        self, uuid: str, filename: str, source_rel_path: str | None = None
    ) -> None:
        super().__init__(uuid, filename, source_rel_path)
        self._ds: Any = None
        self._open_error: str | None = None

    @classmethod
    def _missing_deps(cls) -> list[str]:
        """Return the pip package names still needed to open this node.

        Returns
        -------
        list[str]
            Empty when xarray and at least one backend engine are
            importable; otherwise the packages to install.
        """
        missing: list[str] = []
        if importlib.util.find_spec("xarray") is None:
            missing.append("xarray")
        if not any(
            importlib.util.find_spec(module) is not None
            for _pip, module in cls._ENGINE_MODULES
        ):
            missing.append("netcdf4")
        return missing

    def open(self) -> Any:
        """Open (or return the cached) backing dataset, read-only.

        The first call opens the file with ``xarray.open_dataset`` —
        lazy, so only headers and coordinates are read — and caches the
        handle for the rest of the session. A recorded failure
        short-circuits subsequent calls; :meth:`close` clears it to
        allow a retry.

        Returns
        -------
        xarray.Dataset
            The live (lazily-paged) dataset.

        Raises
        ------
        PDVError
            If required dependencies are missing or the file cannot be
            opened.
        """
        if self._ds is not None:
            return self._ds
        missing = self._missing_deps()
        if missing:
            raise PDVError(
                _dep_error_message("PDVDataset", missing, "netcdf")
            )
        if self._open_error is not None:
            raise PDVError(
                f"Cannot open '{self._filename}': {self._open_error}"
            )
        with _DATA_FILE_OPEN_LOCK:
            if self._ds is not None:
                return self._ds
            import xarray as xr  # noqa: PLC0415

            path = self.resolve_path()
            try:
                self._ds = xr.open_dataset(path)
            except Exception as exc:
                self._open_error = str(exc)
                raise PDVError(
                    f"Cannot open '{self._filename}': {exc}"
                ) from exc
        return self._ds

    @property
    def ds(self) -> Any:
        """The backing ``xarray.Dataset`` (opens the file on first use)."""
        return self.open()

    @property
    def attrs(self) -> dict:
        """Global attributes of the backing dataset."""
        return dict(self.open().attrs)

    def __getitem__(self, key: str) -> Any:
        """Return the variable or coordinate ``key`` as a DataArray."""
        return self.open()[key]

    def keys(self) -> list[str]:
        """Return variable names then coordinate names."""
        ds = self.open()
        return [str(k) for k in ds.data_vars] + [str(k) for k in ds.coords]

    def close(self) -> None:
        """Close the cached handle (if any) and clear any recorded error.

        The next access reopens the file — this is also the retry path
        after a failed open. Serialized with :meth:`open` under the module
        lock so a close on the main thread cannot interleave with handle
        creation on the QueryServer thread.
        """
        with _DATA_FILE_OPEN_LOCK:
            if self._ds is not None:
                try:
                    self._ds.close()
                except Exception:
                    pass
            self._ds = None
            self._open_error = None

    def __pdv_children__(self) -> list:
        """Virtual children: data variables, then coordinates."""
        ds = self.open()
        entries: list = [(str(name), ds[name], None) for name in ds.data_vars]
        entries.extend(
            (str(name), ds[name], {"is_coord": True}) for name in ds.coords
        )
        return entries

    def __pdv_child__(self, key: str) -> Any:
        """Single virtual child lookup for dot-path descent."""
        try:
            return self.open()[key]
        except KeyError:
            raise KeyError(key) from None

    def __pdv_has_children__(self) -> bool:
        """True if the file has any variables or coordinates.

        Never raises: unopenable files simply report no children (the
        expansion attempt itself surfaces the actionable error).
        """
        try:
            return len(self.open().variables) > 0
        except Exception:
            return False

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Returns
        -------
        str
            Variable/coordinate counts, a dependency hint, or an
            unreadable marker — never raises.
        """
        missing = self._missing_deps()
        if missing:
            return f"requires {', '.join(missing)}"
        try:
            ds = self.open()
        except Exception:
            return f"{self._filename} (unreadable)"
        return (
            f"{self._filename} — {len(ds.data_vars)} vars, "
            f"{len(ds.coords)} coords"
        )

    def __getstate__(self) -> dict:
        """Drop the unpicklable live handle for pickle/deepcopy."""
        state = self.__dict__.copy()
        state["_ds"] = None
        state["_open_error"] = None
        return state

    def __setstate__(self, state: dict) -> None:
        """Restore with no live handle; the file reopens on next access."""
        self.__dict__.update(state)
        self._ds = None
        self._open_error = None

    def __repr__(self) -> str:
        return f"PDVDataset(uuid='{self._uuid}', filename='{self._filename}')"


class PDVHdf5(PDVFile):
    """
    Lazy tree node wrapping a general HDF5 file.

    Stored as the value at a tree path (e.g. ``pdv_tree['efit.data']``).
    Like :class:`PDVDataset`, the backing file is copied into UUID
    storage at import time and opened lazily (read-only) on first access;
    h5py pages data from disk on demand and the tree panel walks the
    group hierarchy straight from the file. Save copies the file as-is.

    Access from Python code returns live h5py objects, with native
    slash-path support::

        pdv_tree['efit.data']['profiles/pressure'][:]
        pdv_tree['efit.data.profiles.pressure']   # dot-path descent

    Read-only by design — load data into memory to transform it and
    store results at a normal tree path.

    Requires the optional dependency ``h5py``, checked when the file is
    first opened (not at construction).

    Parameters
    ----------
    uuid : str
        12-hex-character UUID for this node's storage directory.
    filename : str
        Data filename (e.g. ``'efit_reconstruction.h5'``).
    source_rel_path : str or None
        Module-relative source path, or None for ordinary project files.

    See Also
    --------
    PDVDataset : the xarray/NetCDF sibling node type.
    ARCHITECTURE.md §7.2
    """

    def __init__(
        self, uuid: str, filename: str, source_rel_path: str | None = None
    ) -> None:
        super().__init__(uuid, filename, source_rel_path)
        self._handle: Any = None
        self._open_error: str | None = None

    @classmethod
    def _missing_deps(cls) -> list[str]:
        """Return ``['h5py']`` when h5py is not importable, else ``[]``."""
        if importlib.util.find_spec("h5py") is None:
            return ["h5py"]
        return []

    def open(self) -> Any:
        """Open (or return the cached) backing file, read-only.

        Opens with ``locking=False`` so a live read handle never
        interferes with save-time copies of the same file.

        Returns
        -------
        h5py.File
            The live file handle (an ``h5py.Group`` at the root).

        Raises
        ------
        PDVError
            If h5py is missing or the file cannot be opened.
        """
        if self._handle is not None:
            return self._handle
        missing = self._missing_deps()
        if missing:
            raise PDVError(_dep_error_message("PDVHdf5", missing, "hdf5"))
        if self._open_error is not None:
            raise PDVError(
                f"Cannot open '{self._filename}': {self._open_error}"
            )
        with _DATA_FILE_OPEN_LOCK:
            if self._handle is not None:
                return self._handle
            import h5py  # noqa: PLC0415

            path = self.resolve_path()
            try:
                self._handle = h5py.File(path, "r", locking=False)
            except Exception as exc:
                self._open_error = str(exc)
                raise PDVError(
                    f"Cannot open '{self._filename}': {exc}"
                ) from exc
        return self._handle

    @property
    def file(self) -> Any:
        """The backing ``h5py.File`` (opens the file on first use)."""
        return self.open()

    @property
    def attrs(self) -> dict:
        """Root-group attributes of the backing file."""
        return dict(self.open().attrs)

    def __getitem__(self, key: str) -> Any:
        """Return the group or dataset at ``key`` (slash paths work)."""
        return self.open()[key]

    def keys(self) -> list[str]:
        """Return the root group's member names."""
        return [str(k) for k in self.open().keys()]

    def close(self) -> None:
        """Close the cached handle (if any) and clear any recorded error.

        Serialized with :meth:`open` under the module lock so a close on
        the main thread cannot interleave with handle creation on the
        QueryServer thread.
        """
        with _DATA_FILE_OPEN_LOCK:
            if self._handle is not None:
                try:
                    self._handle.close()
                except Exception:
                    pass
            self._handle = None
            self._open_error = None

    def __pdv_children__(self) -> list:
        """Virtual children: the root group's members.

        Deeper levels are served by the ``h5py.Group`` adapter in
        :mod:`pdv.virtual`; returned groups stay valid because they are
        bound to the cached file handle on this node.
        """
        f = self.open()
        return [(str(name), f[name], None) for name in f.keys()]

    def __pdv_child__(self, key: str) -> Any:
        """Single virtual child lookup for dot-path descent."""
        try:
            return self.open()[key]
        except KeyError:
            raise KeyError(key) from None

    def __pdv_has_children__(self) -> bool:
        """True if the root group has any members. Never raises."""
        try:
            return len(self.open()) > 0
        except Exception:
            return False

    def preview(self) -> str:
        """Return a short preview string for the tree panel.

        Returns
        -------
        str
            Root item count, a dependency hint, or an unreadable
            marker — never raises.
        """
        missing = self._missing_deps()
        if missing:
            return f"requires {', '.join(missing)}"
        try:
            f = self.open()
        except Exception:
            return f"{self._filename} (unreadable)"
        return f"{self._filename} — {len(f)} items"

    def __getstate__(self) -> dict:
        """Drop the unpicklable live handle for pickle/deepcopy."""
        state = self.__dict__.copy()
        state["_handle"] = None
        state["_open_error"] = None
        return state

    def __setstate__(self, state: dict) -> None:
        """Restore with no live handle; the file reopens on next access."""
        self.__dict__.update(state)
        self._handle = None
        self._open_error = None

    def __repr__(self) -> str:
        return f"PDVHdf5(uuid='{self._uuid}', filename='{self._filename}')"


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

    # Class-level state for the "global ping" fallback. Any PDVTree instance
    # (even a detached scratch one a user constructs and mutates without
    # assigning to the root) emits a coarse ``change_type: "unknown"``
    # notification through this channel so the renderer knows to refetch.
    # Only the root tree uses precise per-instance path emission.
    _root_tree: "PDVTree | None" = None
    _global_send_fn: Callable[[str, dict], None] | None = None
    _global_pending: bool = False
    _global_timer: threading.Timer | None = None
    _global_lock: threading.Lock = threading.Lock()

    # Monotonic mutation counter served by ``pdv.tree.version`` (query
    # server). The renderer's safety-net poll compares this instead of
    # re-listing every expanded level — one cheap round trip per tick.
    # Bumped by every mutation notification and by the post-execute
    # structural fingerprint (which catches plain-dict mutations that emit
    # nothing). Class-level: versions only need to be comparable within one
    # kernel process.
    _tree_version: int = 0
    _version_lock: threading.Lock = threading.Lock()
    # Post-execute fingerprint state: the last fingerprint of the root tree,
    # and whether any mutation notification fired since the last check (so a
    # fingerprint drift that was already precisely notified doesn't fire a
    # redundant coarse ping).
    _last_fingerprint: int | None = None
    _changed_since_fingerprint: bool = False

    @classmethod
    def _bump_version(cls) -> None:
        """Increment the tree-version counter (thread-safe)."""
        with cls._version_lock:
            cls._tree_version += 1

    @classmethod
    def get_tree_version(cls) -> int:
        """Return the current tree-version counter (thread-safe)."""
        with cls._version_lock:
            return cls._tree_version

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__()
        self._working_dir: str | None = None
        self._save_dir: str | None = None
        # Absolute path to the uv binary, provided by the app at pdv.init for
        # uv-mode kernels (None in shared mode). Used by pdv.install().
        self._uv_binary: str | None = None
        self._send_fn: Callable[[str, dict], None] | None = None
        self._pending_changes: list[tuple[str, str]] = []
        self._debounce_timer: threading.Timer | None = None
        self._debounce_lock = threading.Lock()
        # Route initial data through set_quiet so dotted keys expand into
        # nested nodes and non-string keys are rejected — otherwise
        # ``PDVTree({'a.b': 1})`` would store a literal ``'a.b'`` key that
        # ``__getitem__('a.b')`` can never retrieve.
        if args or kwargs:
            for key, value in dict(*args, **kwargs).items():
                if not isinstance(key, str):
                    raise PDVPathError(
                        f"Tree keys must be strings, got {type(key).__name__}: {key!r}"
                    )
                self.set_quiet(key, value)

    # ------------------------------------------------------------------
    # Internal state management (not user-facing)
    # ------------------------------------------------------------------

    def _set_working_dir(self, path: str) -> None:
        """Set the working directory path. Called by lifecycle handler after pdv.init."""
        self._working_dir = path

    def _set_uv_binary(self, path: str | None) -> None:
        """Set the uv binary path (uv-mode kernels only). Called after pdv.init."""
        self._uv_binary = path

    def _set_save_dir(self, path: str | None) -> None:
        """Set the save directory path. None means no project is loaded."""
        self._save_dir = path

    def _attach_comm(self, send_fn: Callable[[str, dict], None]) -> None:
        """Attach a comm send function for push notifications.

        Wires the caller as the *root tree* — its mutations emit precise
        per-path notifications. Also installs ``send_fn`` as the class-level
        fallback so any other ``PDVTree`` instance (e.g. user-constructed
        scratch trees, intermediate sub-trees) can fire a coarse
        ``change_type: "unknown"`` ping on mutation.

        Parameters
        ----------
        send_fn : callable
            Function with signature ``(type: str, payload: dict) -> None``.
            Called when the tree changes.
        """
        self._send_fn = send_fn
        PDVTree._root_tree = self
        PDVTree._global_send_fn = send_fn

    def _detach_comm(self) -> None:
        """Detach the comm send function (e.g. on kernel restart).

        Clears class-level state if this instance was the root tree.
        """
        self._send_fn = None
        if PDVTree._root_tree is self:
            PDVTree._root_tree = None
            PDVTree._global_send_fn = None
            with PDVTree._global_lock:
                if PDVTree._global_timer is not None:
                    PDVTree._global_timer.cancel()
                    PDVTree._global_timer = None
                PDVTree._global_pending = False

    def _emit_changed(self, path: str, change_type: str) -> None:
        """Queue a change notification and schedule a debounced flush.

        Dispatch:

        - If this instance is the root tree, accumulate ``(path, change_type)``
          into the per-instance queue. Paths are absolute (they come from
          user-facing dot-paths into the root) and a precise
          ``change_type: "batch"`` notification is sent on flush.
        - Otherwise this is a non-root ``PDVTree`` (intermediate sub-tree, or
          a scratch tree the user constructed and is mutating before
          assigning into the root). Local paths can't be reconciled to the
          renderer's absolute view, so fire a coarse class-level
          ``change_type: "unknown"`` ping that triggers a full refetch.

        Both paths are debounced over ``_DEBOUNCE_INTERVAL`` to avoid
        flooding the comm channel during tight mutation loops.

        Parameters
        ----------
        path : str
            The dot-separated path that changed (absolute for root tree,
            local for non-root — only used by the root branch).
        change_type : str
            One of ``'added'``, ``'removed'``, or ``'updated'``.
        """
        PDVTree._bump_version()
        PDVTree._changed_since_fingerprint = True
        if self is PDVTree._root_tree:
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
        else:
            PDVTree._emit_global_ping()

    @classmethod
    def _emit_global_ping(cls) -> None:
        """Schedule a debounced ``change_type: "unknown"`` notification.

        Called by mutations on non-root ``PDVTree`` instances. The renderer
        treats the unknown change_type as "something changed somewhere,
        refetch the visible tree."
        """
        if cls._global_send_fn is None:
            return
        with cls._global_lock:
            cls._global_pending = True
            if cls._global_timer is not None:
                cls._global_timer.cancel()
            cls._global_timer = threading.Timer(
                cls._DEBOUNCE_INTERVAL, cls._flush_global
            )
            cls._global_timer.daemon = True
            cls._global_timer.start()

    @classmethod
    def _disarm_global_debounce(cls) -> None:
        """Unconditionally cancel and clear the class-level debounce state.

        Unlike :meth:`_detach_comm` (which only acts when called on the
        current root tree), this always disarms — it exists for test
        harnesses that must guarantee no debounce timer survives a test,
        regardless of which tree instances the test created or leaked.
        """
        with cls._global_lock:
            if cls._global_timer is not None:
                cls._global_timer.cancel()
                cls._global_timer = None
            cls._global_pending = False
        cls._global_send_fn = None
        cls._root_tree = None

    @classmethod
    def _flush_global(cls) -> None:
        """Send the pending ``change_type: "unknown"`` notification.

        Called by the class-level debounce timer.
        """
        with cls._global_lock:
            if not cls._global_pending:
                return
            cls._global_pending = False
            cls._global_timer = None
            send_fn = cls._global_send_fn
        if send_fn is None:
            return
        send_fn(
            "pdv.tree.changed",
            {"changed_paths": [], "change_type": "unknown"},
        )

    @classmethod
    def _structure_fingerprint(cls, tree: dict) -> int:
        """Compute a cheap structural fingerprint of *tree*.

        Captures what the renderer's listings display: keys, value type
        names, scalar values (whose previews show the value), and
        shape/length for sized containers (whose previews show structure,
        not contents). Deliberately never touches array/dataframe contents,
        so the walk stays fast on large data. Bounded by a node budget and a
        depth cap against pathological trees.

        Fingerprints are only compared within one kernel process, so
        Python's per-process ``hash()`` randomization is harmless.

        Parameters
        ----------
        tree : dict
            The root tree (or any dict) to fingerprint.

        Returns
        -------
        int
            A hash that changes when the renderer-visible structure does.
        """
        parts: list[object] = []
        budget = 100_000

        def visit(node: dict, depth: int) -> None:
            nonlocal budget
            if depth > 32:
                return
            for key in list(dict.keys(node)):
                if budget <= 0:
                    return
                budget -= 1
                try:
                    value = dict.__getitem__(node, key)
                except KeyError:
                    continue  # deleted concurrently
                parts.append(key)
                if isinstance(value, dict):
                    parts.append("{")
                    visit(value, depth + 1)
                    parts.append("}")
                    continue
                parts.append(type(value).__name__)
                if value is None or isinstance(value, (bool, int, float, str)):
                    parts.append(value)
                else:
                    shape = getattr(value, "shape", None)
                    if shape is not None:
                        parts.append(str(shape))
                    else:
                        try:
                            parts.append(len(value))  # type: ignore[arg-type]
                        except TypeError:
                            pass

        visit(tree, 0)
        return hash(tuple(parts))

    @classmethod
    def _post_execute_check(cls) -> None:
        """Detect silent tree mutations after each execution.

        Registered as an IPython ``post_execute`` event. Plain-dict
        mutations under the tree (``pdv_tree['data']['x'] = 1`` where
        ``data`` is a plain dict) emit no change notification; comparing a
        structural fingerprint before/after execution catches them at the
        source. On silent drift, the version counter is bumped and a coarse
        ``change_type: "unknown"`` ping is emitted so the renderer refreshes
        immediately. Drift that was already precisely notified only records
        the new fingerprint (the precise push and version bump already
        happened).
        """
        root = cls._root_tree
        if root is None:
            return
        try:
            fingerprint = cls._structure_fingerprint(root)
        except Exception:  # noqa: BLE001 — user objects can break anything
            return
        already_notified = cls._changed_since_fingerprint
        cls._changed_since_fingerprint = False
        if fingerprint == cls._last_fingerprint:
            return
        first_check = cls._last_fingerprint is None
        cls._last_fingerprint = fingerprint
        if already_notified or first_check:
            return
        cls._bump_version()
        cls._emit_global_ping()

    def _flush_changes(self) -> None:
        """Send all pending change notifications as a single batch.

        Deduplicates by path, keeping the last change_type per path.
        Called automatically by the debounce timer, or manually in tests.
        """
        with self._debounce_lock:
            pending = self._pending_changes
            self._pending_changes = []
            # Cancel before dropping the reference: a manual flush (tests,
            # _detach_comm) would otherwise leave the timer thread alive to
            # re-enter this method ~100 ms later. Harmless no-op when this
            # call *is* the timer firing.
            if self._debounce_timer is not None:
                self._debounce_timer.cancel()
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

    def __getstate__(self) -> dict:
        """Return picklable instance state, dropping runtime-only attributes.

        The debounce lock/timer and the comm send-fn are not picklable and
        are rebuilt on unpickle (see :meth:`__setstate__`). Because
        ``copy.deepcopy`` uses the same ``__reduce_ex__`` machinery, this
        also makes deepcopy work — without it, both raise
        ``TypeError: cannot pickle '_thread.lock' object``. Subclass
        attributes (``PDVModule._module_id``, etc.) survive because they
        live in ``__dict__``.
        """
        state = self.__dict__.copy()
        state.pop("_debounce_lock", None)
        state.pop("_debounce_timer", None)
        state.pop("_send_fn", None)
        state["_pending_changes"] = []
        return state

    def __setstate__(self, state: dict) -> None:
        """Restore instance state, rebuilding runtime-only attributes.

        The restored tree is intentionally *detached*: ``_send_fn`` is None,
        so it emits no notifications until inserted into the root tree.
        """
        self.__dict__.update(state)
        self._debounce_lock = threading.Lock()
        self._debounce_timer = None
        self._send_fn = None
        if "_pending_changes" not in self.__dict__:
            self._pending_changes = []

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

    def get(self, key: str, default: Any = None) -> Any:
        """Get a value by key or dot-path, returning *default* if absent.

        Unlike ``dict.get``, this resolves dot-separated paths the same way
        ``__getitem__``/``__contains__`` do, so ``tree.get('a.b')`` and
        ``tree['a.b']`` agree instead of ``get`` silently returning the
        default for any dotted path.
        """
        try:
            return self[key]
        except PDVKeyError:
            return default

    def copy(self) -> "PDVTree":
        """Return a shallow copy that preserves the node's actual type.

        Unlike ``dict.copy`` (which returns a plain ``dict``, silently
        dropping the PDVTree type, working/save dirs, and any subclass
        attributes), this rebuilds the same class with the same instance
        state. The copy is *detached* — no comm attached — so mutating it
        emits no notifications until it is inserted into the root tree.
        Values are shared (shallow), matching ``dict.copy`` semantics.
        """
        new = type(self).__new__(type(self))
        new.__setstate__(self.__getstate__())
        for k in dict.keys(self):
            dict.__setitem__(new, k, dict.__getitem__(self, k))
        return new

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
        except Exception:
            # Membership must never raise. Besides the ordinary
            # KeyError/TypeError misses, descent through a virtual
            # container (pdv.virtual) can fail with a library error or a
            # missing-optional-dependency PDVError — for ``in`` purposes
            # all of those mean "not reachable".
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
