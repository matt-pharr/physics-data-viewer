"""
pdv_kernel.handlers — PDV comm message handler dispatch table.

Maps PDV message type strings to handler functions. Each handler
receives a parsed PDV message dict and is responsible for:

1. Extracting the payload.
2. Performing the requested action.
3. Calling ``pdv_kernel.comms.send_message()`` with the response.

Handler functions must NOT raise exceptions to the caller — all errors
must be caught and returned as ``status='error'`` responses using
``pdv_kernel.comms.send_error()``.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
"""

from __future__ import annotations

from typing import Callable

# Import handlers from submodules.
# Each submodule registers itself by calling register() below.
_DISPATCH: dict[str, Callable[[dict], None]] = {}


def register(msg_type: str, handler: Callable[[dict], None]) -> None:
    """Register a handler for a PDV message type.

    Parameters
    ----------
    msg_type : str
        The PDV message type string (e.g. ``'pdv.tree.list'``).
    handler : callable
        Function accepting a parsed PDV message dict and returning None.
    """
    _DISPATCH[msg_type] = handler


def dispatch(msg: dict) -> None:
    """Dispatch a parsed PDV message to its registered handler.

    If no handler is registered for the message type, sends a
    ``protocol.unknown_type`` error response.

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope (see ARCHITECTURE.md §3.2).
    """
    # TODO: implement in Step 2
    raise NotImplementedError


# Register all handlers by importing submodules.
# These imports must come AFTER the register() function is defined.
from pdv_kernel.handlers import lifecycle, project, tree, namespace, script  # noqa: E402, F401
