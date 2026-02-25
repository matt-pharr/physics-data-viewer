"""
pdv_kernel — Physics Data Viewer kernel support package.

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
    Base exception for all pdv_kernel errors.
bootstrap : function
    Called by IPython startup machinery. Registers the PDV comm target,
    injects ``pdv_tree`` and ``pdv`` into the protected namespace, and
    sends the ``pdv.ready`` message. See ARCHITECTURE.md §5.3.

Do not import comms, handlers, or namespace internals directly — they
are implementation details and their interfaces may change.
"""

from pdv_kernel.tree import PDVTree, PDVScript
from pdv_kernel.errors import PDVError

__version__ = "1.0.0"
__pdv_protocol_version__ = "1.0"

__all__ = ["PDVTree", "PDVScript", "PDVError", "bootstrap", "__version__"]


def bootstrap(ip=None):
    """
    Bootstrap the PDV kernel package inside a running IPython kernel.

    This is the entry point called by the IPython startup mechanism.
    It must be idempotent — calling it twice must produce no side effects
    beyond the first call.

    Registers the ``pdv.kernel`` comm target, installs the protected
    :class:`PDVNamespace` as the IPython user namespace, injects
    ``pdv_tree`` and ``pdv``, and sends the ``pdv.ready`` comm message.

    Parameters
    ----------
    ip : InteractiveShell, optional
        The IPython shell instance. If None, obtained via
        ``IPython.get_ipython()``.

    See Also
    --------
    ARCHITECTURE.md §4.1 (startup sequence), §5.3 (bootstrap detail)
    """
    import pdv_kernel.comms as comms_mod  # noqa: PLC0415

    if comms_mod._bootstrapped:
        return

    if ip is None:
        try:
            import IPython  # noqa: PLC0415

            ip = IPython.get_ipython()
        except ImportError:
            pass

    from pdv_kernel.namespace import PDVApp, PDVNamespace  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

    # Create the tree and app objects
    tree = PDVTree()
    app = PDVApp()

    # Install the protected namespace and inject pdv_tree and pdv
    if ip is not None:
        existing = dict(ip.user_ns)
        protected_ns = PDVNamespace(existing)
        # Bypass protection to inject PDV names (bootstrap is the only caller)
        dict.__setitem__(protected_ns, "pdv_tree", tree)
        dict.__setitem__(protected_ns, "pdv", app)
        ip.user_ns = protected_ns

    # Store references in comms module for handler use
    comms_mod._pdv_tree = tree
    comms_mod._ip = ip

    # Attach the comm send function to the tree for push notifications
    tree._attach_comm(lambda msg_type, payload: comms_mod.send_message(msg_type, payload))

    # Register the comm target with IPython so the app can connect
    if ip is not None:
        comms_mod.register_comm_target(ip)

    # Configure a non-blocking interactive matplotlib backend so that
    # plt.show() opens native windows rather than falling back to the
    # ipykernel default (inline/Agg), which would silently swallow plots.
    # This must run before any `import matplotlib.pyplot` in user code.
    # Users can still override with %matplotlib <backend> after bootstrap.
    _configure_matplotlib()

    comms_mod._bootstrapped = True


def _configure_matplotlib() -> None:
    """Set a sensible default matplotlib backend for native-mode PDV.

    Tries platform-appropriate interactive backends in order, falling back
    to Agg so that at minimum figures can be captured via ``pdv_show()``.
    Silently skips if matplotlib is not installed.
    """
    import sys  # noqa: PLC0415

    try:
        import matplotlib  # noqa: PLC0415
    except ImportError:
        return

    # If a backend was already set (e.g. user's matplotlibrc or a previous
    # import of pyplot), respect it and do nothing.
    current = matplotlib.get_backend().lower()
    if current not in ("agg", "module://matplotlib_inline.backend_inline", ""):
        return

    if sys.platform == "darwin":
        candidates = ["MacOSX", "TkAgg", "Agg"]
    elif sys.platform.startswith("win"):
        candidates = ["TkAgg", "Qt5Agg", "Agg"]
    else:
        candidates = ["Qt5Agg", "TkAgg", "GTK4Agg", "Agg"]

    for backend in candidates:
        try:
            matplotlib.use(backend)
            return
        except Exception:
            continue
