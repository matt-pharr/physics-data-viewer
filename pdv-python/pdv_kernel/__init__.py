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
    # TODO: implement in Step 2
    raise NotImplementedError("bootstrap() not yet implemented — see IMPLEMENTATION_STEPS.md Step 2")
