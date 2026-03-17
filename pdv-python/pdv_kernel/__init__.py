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

from pdv_kernel.tree import PDVTree, PDVFile, PDVScript, PDVGui, PDVModule
from pdv_kernel.errors import PDVError
from pdv_kernel.modules import handle

__version__ = "1.0.0"
__pdv_protocol_version__ = "1.0"

__all__ = [
    "PDVTree", "PDVFile", "PDVScript", "PDVGui", "PDVModule",
    "PDVError", "bootstrap", "handle", "__version__",
]


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

    from pdv_kernel.modules import handle as _handle_decorator  # noqa: PLC0415

    # Create the tree and app objects
    tree = PDVTree()
    app = PDVApp()
    app.handle = _handle_decorator  # type: ignore[attr-defined]

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
    print("[PDV] No interactive matplotlib backend found — figures will render inline in the PDV console.")
