"""
pdv_kernel.handlers.namespace — Handler for PDV namespace query messages.

Handles:
- ``pdv.namespace.query``: return a snapshot of the kernel user
  namespace for the Namespace panel.

See Also
--------
ARCHITECTURE.md §3.4 (namespace messages)
pdv_kernel.namespace.pdv_namespace
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_namespace_query(msg: dict) -> None:
    """Handle the ``pdv.namespace.query`` message.

    Returns a snapshot of the current kernel user namespace.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "include_private": false,
            "include_modules": false,
            "include_callables": false
        }

    All fields are optional and default to ``false``.

    Response payload
    ----------------
    .. code-block:: json

        { "variables": { "<name>": <descriptor>, ... } }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    # TODO: implement in Step 2
    raise NotImplementedError


register("pdv.namespace.query", handle_namespace_query)
