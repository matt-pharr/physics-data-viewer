"""
pdv — Physics Data Viewer kernel support package.

This package implements the kernel side of the PDV comm protocol.
It is installed into the user's Python environment and loaded when a
PDV-managed Jupyter kernel starts.

Public API
----------
PDVTree : class
    The live project data tree. Injected into the kernel namespace as
    ``pdv_tree``. This is the sole authority on all project data.
PDVScript : class
    Lightweight wrapper for a script file stored as a tree node.
PDVError : exception
    Base exception for all pdv errors.
bootstrap : function
    Called by IPython startup machinery. Registers the PDV comm target,
    injects ``pdv_tree`` into the protected namespace, and sends the
    ``pdv.ready`` message. See ARCHITECTURE.md §5.3.

Do not import comms, handlers, or namespace internals directly — they
are implementation details and their interfaces may change.
"""

from __future__ import annotations

import sys as _sys

# PDV's kernel pipeline depends on pyzmq, jupyter_client, and ipykernel. None
# of those declare themselves free-thread-safe yet (PEP 703), so importing
# them on a no-GIL Python build fails inside pyzmq's C extension with a
# cryptic "init function returned uninitialized object" error. Refuse to
# import here with a clearer message instead. `_is_gil_enabled` was added in
# Python 3.13 — the only version where free-threaded builds exist.
if hasattr(_sys, "_is_gil_enabled") and not _sys._is_gil_enabled():
    raise ImportError(
        "pdv-python does not support free-threaded (no-GIL) Python builds. "
        "Its dependencies (pyzmq, jupyter_client, ipykernel) are not yet "
        "free-thread-safe. Use a standard (GIL-enabled) CPython build of "
        "Python 3.10–3.14 instead. If your conda env is named '<x>t', it "
        "is the free-threaded variant; create one with `conda create -n <x> "
        "python=3.14` (no 't') and select that env in PDV."
    )

from pathlib import Path
from typing import TYPE_CHECKING

from pdv.tree import (
    PDVTree,
    PDVFile,
    PDVScript,
    PDVNote,
    PDVGui,
    PDVNamelist,
    PDVModule,
    PDVLib,
    PDVDataset,
    PDVHdf5,
)
from pdv.errors import PDVError
from pdv.modules import handle
from pdv.serializers import register as register_serializer

from importlib.metadata import (
    version as _pkg_version,
    PackageNotFoundError as _PkgNotFound,
)

if TYPE_CHECKING:
    from pdv.tree import PDVFile as _PDVFile

try:
    __version__ = _pkg_version("pdv-python")
except _PkgNotFound:
    __version__ = "0.0.0"

__all__ = [
    "PDVTree",
    "PDVFile",
    "PDVScript",
    "PDVNote",
    "PDVGui",
    "PDVNamelist",
    "PDVModule",
    "PDVLib",
    "PDVDataset",
    "PDVHdf5",
    "PDVError",
    "bootstrap",
    "handle",
    "register_serializer",
    "log",
    "__version__",
    "save",
    "save_project",
    "save_project_as",
    "open_project",
    "install",
    "add_file",
    "add_dataset",
    "add_hdf5",
    "new_note",
    "help",
    "working_dir",
]

_DYNAMIC_ATTRS = frozenset({"working_dir"})


def _get_tree() -> PDVTree:
    """Return the bootstrapped PDVTree, or raise if bootstrap hasn't run."""
    from pdv.comms import get_pdv_tree  # noqa: PLC0415

    tree = get_pdv_tree()
    if tree is None:
        raise RuntimeError("PDV kernel has not been bootstrapped")
    return tree


def _working_dir() -> Path:
    """Return the session working directory as a Path."""
    tree = _get_tree()
    wd = getattr(tree, "_working_dir", None)
    if not wd:
        raise PDVError(
            "pdv.working_dir is not available: kernel has not received pdv.init"
        )
    return Path(wd)


def save() -> None:
    """Trigger a project save. Equivalent to File -> Save in the UI."""
    save_project()


def save_project(path: str | None = None) -> None:
    """Save the current project to a directory.

    Parameters
    ----------
    path : str or None
        Absolute or ``~``-prefixed path to the project directory.
        If None, saves to the current project location (falls back
        to :func:`save` if no project is open).
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
        if results.get("missing_files"):
            # The save was aborted before tree-index.json was written (see
            # serialize_tree_to_dir). The app also surfaces this, but the
            # user invoked save_project() from the console, so say it here.
            missing = results["missing_files"]
            print(
                f"PDV: save aborted — {len(missing)} node(s) have missing "
                f"backing files; nothing was persisted:\n  "
                + "\n  ".join(missing)
            )
        send_message(
            "pdv.project.save_completed",
            {"save_dir": save_dir, **results},
        )
    except RuntimeError:
        print("PDV: No comm channel open. Cannot trigger save.")
    except Exception as exc:  # noqa: BLE001
        print(f"PDV: save_project failed: {exc}")


def save_project_as(path: str) -> None:
    """Save the project to a new directory (Save As).

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


def install(*packages: str) -> None:
    """Install Python packages into the current project's uv environment.

    Runs ``uv add`` against the project, installing the packages into the venv
    the kernel is running in and recording them in ``pyproject.toml`` so they
    persist. The packages become importable without a kernel restart
    (ARCHITECTURE.md §10.5.11). Only available in uv-managed project
    environments.

    Parameters
    ----------
    *packages : str
        PEP 508 specifiers, e.g. ``pdv.install("xarray", "netcdf4>=1.6")``.

    Raises
    ------
    PDVError
        If the project is not a uv environment, or ``uv add`` fails.
    """
    import importlib  # noqa: PLC0415
    import re  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import sys  # noqa: PLC0415

    if not packages:
        print("pdv.install: no packages specified.")
        return

    tree = _get_tree()
    uv_binary = getattr(tree, "_uv_binary", None)
    working_dir = getattr(tree, "_working_dir", None)
    if not uv_binary or not working_dir:
        raise PDVError(
            "pdv.install() requires a uv-managed project environment. This "
            "project uses a shared environment; install packages with that "
            "environment's own package manager (pip/conda)."
        )

    # Best-effort note of packages already imported this session: uv installs
    # them, but the live module object can't be swapped without a kernel
    # restart (§10.5.11).
    def _import_name(spec: str) -> str:
        return re.split(r"[<>=!~\[; ]", spec.strip(), maxsplit=1)[0].replace("-", "_")

    already_imported = sorted(
        {_import_name(p) for p in packages if _import_name(p) in sys.modules}
    )

    print(f"pdv.install: uv add {' '.join(packages)}", flush=True)
    proc = subprocess.Popen(
        [uv_binary, "add", *packages],
        cwd=working_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in proc.stdout or []:
        print(line, end="")
    returncode = proc.wait()
    if returncode != 0:
        raise PDVError(f"pdv.install: 'uv add' failed (exit code {returncode}).")

    importlib.invalidate_caches()

    if already_imported:
        print(
            "pdv.install: "
            + ", ".join(already_imported)
            + " already imported in this session — restart the kernel for the "
            "updated version to take effect.",
            file=sys.stderr,
        )


def open_project(path: str) -> None:
    """Open a project from a directory.

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


# File extensions that auto-detect to a typed data node in add_file and
# the GUI Add File flow. Mirrored in pdv/handlers/namelist.py
# (handle_file_register) — keep the two in sync.
DATASET_EXTENSIONS = (".nc", ".cdf")
HDF5_EXTENSIONS = (".h5", ".hdf5")


def _import_file_common(source_path: str, api_name: str) -> tuple[str, str]:
    """Copy ``source_path`` into fresh UUID storage; return (uuid, filename).

    Shared body of :func:`add_file` / :func:`add_dataset` /
    :func:`add_hdf5`: resolves and validates the source path, requires an
    initialized kernel working directory, and ``smart_copy``-s the file
    to ``<working_dir>/tree/<uuid>/<filename>``.

    Parameters
    ----------
    source_path : str
        Filesystem path to the source file. ``~`` is expanded.
    api_name : str
        The public function name, used in error messages.

    Returns
    -------
    tuple[str, str]
        The freshly minted node UUID and the file's basename.

    Raises
    ------
    FileNotFoundError
        If ``source_path`` does not exist.
    ValueError
        If ``source_path`` is not a regular file.
    PDVError
        If no kernel working directory is available.
    """
    import os  # noqa: PLC0415

    from pdv.comms import get_pdv_tree  # noqa: PLC0415
    from pdv.environment import (  # noqa: PLC0415
        generate_node_uuid,
        smart_copy,
        uuid_tree_path,
    )

    resolved = os.path.realpath(os.path.expanduser(source_path))
    if not os.path.exists(resolved):
        raise FileNotFoundError(f"Source file not found: {source_path}")
    if not os.path.isfile(resolved):
        raise ValueError(f"Source path is not a file: {source_path}")

    tree = get_pdv_tree()
    working_dir = getattr(tree, "_working_dir", None) if tree is not None else None
    if not working_dir:
        raise PDVError(
            f"pdv.{api_name} is not available: kernel has not received pdv.init"
        )

    filename = os.path.basename(resolved)
    node_uuid = generate_node_uuid()
    dest = uuid_tree_path(working_dir, node_uuid, filename)
    smart_copy(resolved, dest)
    return node_uuid, filename


def add_file(source_path: str) -> _PDVFile:
    """Import a file into the tree, auto-detecting scientific data types.

    Eagerly copies the source file into the session working directory
    under a fresh UUID-based storage path. The returned node is not
    yet attached to the tree — assign it at the desired tree path::

        mesh = pdv.add_file("~/Downloads/mesh.h5")
        pdv_tree["simulation.mesh"] = mesh

    Files with a NetCDF extension (``.nc``, ``.cdf``) come back as
    :class:`PDVDataset` and HDF5 extensions (``.h5``, ``.hdf5``) as
    :class:`PDVHdf5` — lazily-read, tree-expandable data nodes. Use
    :func:`add_dataset` / :func:`add_hdf5` to force a type for files
    with unusual extensions. Everything else imports as a plain
    :class:`PDVFile`.

    Parameters
    ----------
    source_path : str
        Filesystem path to the source file. ``~`` is expanded.

    Returns
    -------
    PDVFile
        A new file-backed node wrapping the imported file
        (``PDVDataset``/``PDVHdf5`` when the extension matches).

    Raises
    ------
    FileNotFoundError
        If ``source_path`` does not exist.
    ValueError
        If ``source_path`` is not a regular file.
    PDVError
        If no kernel working directory is available.
    """
    import os  # noqa: PLC0415

    from pdv.tree import PDVDataset, PDVFile, PDVHdf5  # noqa: PLC0415

    node_uuid, filename = _import_file_common(source_path, "add_file")
    ext = os.path.splitext(filename)[1].lower()
    if ext in DATASET_EXTENSIONS:
        _preimport("xarray")
        return PDVDataset(uuid=node_uuid, filename=filename)
    if ext in HDF5_EXTENSIONS:
        _preimport("h5py")
        return PDVHdf5(uuid=node_uuid, filename=filename)
    return PDVFile(uuid=node_uuid, filename=filename)


def add_dataset(source_path: str) -> "PDVDataset":
    """Import a NetCDF file into the tree as a :class:`PDVDataset`.

    Like :func:`add_file` but always constructs a dataset node regardless
    of extension, and checks that xarray plus a NetCDF backend engine are
    installed *before* copying the file — so a missing dependency fails
    fast with an actionable message instead of after a multi-GB copy.

    Parameters
    ----------
    source_path : str
        Filesystem path to the NetCDF file. ``~`` is expanded.

    Returns
    -------
    PDVDataset
        A new lazily-read dataset node wrapping the imported file.

    Raises
    ------
    PDVError
        If required dependencies are missing (before any copy) or no
        kernel working directory is available.
    FileNotFoundError
        If ``source_path`` does not exist.
    ValueError
        If ``source_path`` is not a regular file.
    """
    from pdv.tree import PDVDataset, _dep_error_message  # noqa: PLC0415

    missing = PDVDataset._missing_deps()
    if missing:
        raise PDVError(_dep_error_message("PDVDataset", missing, "netcdf"))
    _preimport("xarray")
    node_uuid, filename = _import_file_common(source_path, "add_dataset")
    return PDVDataset(uuid=node_uuid, filename=filename)


def add_hdf5(source_path: str) -> "PDVHdf5":
    """Import an HDF5 file into the tree as a :class:`PDVHdf5`.

    Like :func:`add_file` but always constructs an HDF5 node regardless
    of extension, and checks that h5py is installed *before* copying the
    file.

    Parameters
    ----------
    source_path : str
        Filesystem path to the HDF5 file. ``~`` is expanded.

    Returns
    -------
    PDVHdf5
        A new lazily-read HDF5 node wrapping the imported file.

    Raises
    ------
    PDVError
        If h5py is missing (before any copy) or no kernel working
        directory is available.
    FileNotFoundError
        If ``source_path`` does not exist.
    ValueError
        If ``source_path`` is not a regular file.
    """
    from pdv.tree import PDVHdf5, _dep_error_message  # noqa: PLC0415

    missing = PDVHdf5._missing_deps()
    if missing:
        raise PDVError(_dep_error_message("PDVHdf5", missing, "hdf5"))
    _preimport("h5py")
    node_uuid, filename = _import_file_common(source_path, "add_hdf5")
    return PDVHdf5(uuid=node_uuid, filename=filename)


def _preimport(module: str) -> None:
    """Pre-import a data library on the main thread (see environment.py)."""
    from pdv.environment import preimport_data_libs  # noqa: PLC0415

    preimport_data_libs(module)


def new_note(path: str, title: str | None = None) -> None:
    """Create a markdown note in the tree.

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
    from pdv.tree import PDVNote as _Note  # noqa: PLC0415

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

    note = _Note(uuid=node_uuid, filename=filename, title=title)
    tree[path] = note
    print(f"Created note at '{path}'")


def help(topic: str | None = None) -> None:  # noqa: A001
    """Print PDV help.

    Parameters
    ----------
    topic : str, optional
        A specific topic to get help on. If None, prints a general overview.
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


def __getattr__(name: str):
    if name == "working_dir":
        return _working_dir()
    raise AttributeError(f"module 'pdv' has no attribute {name!r}")


def __dir__():
    return list(set(globals().keys()) | _DYNAMIC_ATTRS)


def log(*args, **kwargs) -> None:
    """Print a debug message directly to stderr, bypassing ipykernel's stdout capture.

    Output appears in the Electron terminal prefixed with ``[kernel:<id>]``.
    Accepts the same arguments as the built-in ``print()``.
    """
    import io as _io  # noqa: PLC0415
    import os as _os  # noqa: PLC0415

    # ipykernel replaces sys.stderr with its own stream, so we write
    # directly to file descriptor 2 to guarantee output reaches the
    # spawned process's piped stderr.
    _real_stderr = _io.TextIOWrapper(
        _io.FileIO(_os.dup(2), mode="w", closefd=True),
        encoding="utf-8",
        line_buffering=True,
    )
    kwargs.setdefault("file", _real_stderr)
    kwargs.setdefault("flush", True)
    print(*args, **kwargs)
    _real_stderr.close()


def bootstrap(ip=None):
    """
    Bootstrap the PDV kernel package inside a running IPython kernel.

    This is the entry point called by the IPython startup mechanism.
    It must be idempotent — calling it twice must produce no side effects
    beyond the first call.

    Registers the ``pdv.kernel`` comm target, installs the protected
    :class:`PDVNamespace` as the IPython user namespace, injects
    ``pdv_tree``, and sends the ``pdv.ready`` comm message.

    Parameters
    ----------
    ip : InteractiveShell, optional
        The IPython shell instance. If None, obtained via
        ``IPython.get_ipython()``.

    See Also
    --------
    ARCHITECTURE.md §4.1 (startup sequence), §5.3 (bootstrap detail)
    """
    import pdv.comms as comms_mod  # noqa: PLC0415

    if comms_mod._bootstrapped:
        return

    if ip is None:
        try:
            import IPython  # noqa: PLC0415

            ip = IPython.get_ipython()
        except ImportError:
            pass

    from pdv.namespace import PDVNamespace  # noqa: PLC0415
    from pdv.tree import PDVTree  # noqa: PLC0415

    tree = PDVTree()

    # Install the protected namespace and inject pdv_tree.
    # IPython uses user_module.__dict__ as globals and user_ns as locals
    # in exec(). They must be the same object so that top-level assignments
    # are visible inside nested functions. We call prepare_user_module()
    # which rebuilds user_module so its __dict__ returns our PDVNamespace,
    # keeping globals and locals in sync.
    if ip is not None:
        existing = dict(ip.user_ns)
        protected_ns = PDVNamespace(existing)
        # Bypass protection to inject PDV names (bootstrap is the only caller)
        dict.__setitem__(protected_ns, "pdv_tree", tree)
        try:
            from IPython.core.interactiveshell import InteractiveShell  # noqa: PLC0415

            is_real_shell = isinstance(ip, InteractiveShell)
        except ImportError:
            is_real_shell = False
        if is_real_shell:
            ip.user_module, ip.user_ns = ip.prepare_user_module(user_ns=protected_ns)
        else:
            ip.user_ns = protected_ns

    # Store references in comms module for handler use
    comms_mod._pdv_tree = tree
    comms_mod._ip = ip

    # Attach the comm send function to the tree for push notifications
    tree._attach_comm(
        lambda msg_type, payload: comms_mod.send_message(msg_type, payload)
    )

    # Register the comm target with IPython so the app can connect
    if ip is not None:
        comms_mod.register_comm_target(ip)

    # Configure a non-blocking interactive matplotlib backend so that
    # plt.show() opens native windows rather than falling back to the
    # ipykernel default (inline/Agg), which would silently swallow plots.
    # This must run before any `import matplotlib.pyplot` in user code.
    # Users can still override with %matplotlib <backend> after bootstrap.
    _configure_matplotlib()

    # Built-in double-click plot handlers (ndarray / Series / DataFrame /
    # DataArray) register lazily: the handler-registry lookups in
    # pdv.modules call default_handlers.register_defaults(), which
    # registers per-library defaults once numpy/pandas/xarray actually
    # appear in sys.modules. Importing those libraries here cost real
    # startup latency and undercut serialization.py's never-import-xarray
    # design, so bootstrap deliberately does nothing for them.

    # Pay jedi's first-call grammar-table load cost here, on the same shell
    # thread that will later serve complete_request, so the user's first
    # completion isn't a 3–8 s stall (which serializes against execute_request).
    if ip is not None:
        try:
            ip.complete("pdv_tree.")
        except Exception:
            pass

    comms_mod._bootstrapped = True


def _configure_matplotlib() -> None:
    """Set a sensible default matplotlib backend for native-mode PDV.

    Tries platform-appropriate interactive backends in order.  If none are
    available, falls back to Agg and monkey-patches ``plt.show()`` so that
    figures are emitted as ``display_data`` iopub messages and appear inline
    in the PDV console.

    Silently skips if matplotlib is not installed.
    """
    import sys  # noqa: PLC0415

    try:
        import matplotlib  # noqa: PLC0415
    except ImportError:
        return

    # If a non-trivial backend is already configured (e.g. user's matplotlibrc
    # or a previous import of pyplot), respect it and do nothing.
    current = matplotlib.get_backend().lower()
    _inline_backends = (
        "agg",
        "module://matplotlib_inline.backend_inline",
        "module://ipykernel.pylab.backend_inline",
        "",
    )
    if current not in _inline_backends:
        return

    if sys.platform == "darwin":
        candidates = ["MacOSX", "TkAgg"]
    elif sys.platform.startswith("win"):
        candidates = ["TkAgg", "Qt5Agg"]
    else:
        candidates = ["Qt5Agg", "TkAgg", "GTK4Agg"]

    for backend in candidates:
        try:
            matplotlib.use(backend)
            # Enable interactive mode so plt.show() is non-blocking — the
            # plot window opens and the kernel returns to idle immediately.
            import matplotlib.pyplot as _plt  # noqa: PLC0415

            _plt.ion()
            return
        except Exception:
            continue

    # No interactive backend available.  Stay on Agg and patch plt.show() so
    # that figures are sent to the PDV console as inline images.
    matplotlib.use("Agg")
    _patch_plt_show_for_inline_capture()


def _patch_plt_show_for_inline_capture() -> None:
    """Monkey-patch ``plt.show()`` to emit figures as display_data messages.

    Only called when no interactive matplotlib backend is available.  Uses
    IPython's ``display()`` / ``Image`` so the image appears in the PDV
    console output just like any other captured result.
    """
    try:
        import matplotlib.pyplot as plt  # noqa: PLC0415
    except ImportError:
        return

    _original_show = plt.show

    def _pdv_inline_show(*args, **kwargs):
        _ = (args, kwargs)  # swallow block= and other kwargs
        try:
            import io  # noqa: PLC0415
            import base64  # noqa: PLC0415

            fig = plt.gcf()
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            buf.seek(0)
            png_b64 = base64.b64encode(buf.read()).decode("ascii")
            buf.close()

            try:
                from IPython.display import display, Image  # noqa: PLC0415

                display(Image(data=base64.b64decode(png_b64), format="png"))
            except ImportError:
                # IPython not available — nothing we can do
                pass

            plt.close(fig)
        except Exception as exc:
            print(f"[PDV] Could not capture figure: {exc}")

    plt.show = _pdv_inline_show
    print(
        "[PDV] No interactive matplotlib backend found — figures will render inline in the PDV console."
    )
