"""
pdv_kernel.handlers.script — Handler for PDV script registration messages.

Handles:
- ``pdv.script.register``: attach a :class:`PDVScript` node to the tree
  at the specified parent path and name.

See Also
--------
ARCHITECTURE.md §3.4 (script messages)
pdv_kernel.tree.PDVScript
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_script_register(msg: dict) -> None:
    """Handle the ``pdv.script.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVScript` and attaches it to the
    tree at ``parent_path.name``. Sends a ``pdv.tree.changed`` push
    notification on success.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "parent_path": "scripts.analysis",
            "name": "fit_model",
            "relative_path": "tree/scripts/analysis/fit_model.py",
            "language": "python"
        }

    Response type: ``pdv.script.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    # TODO: implement in Step 2
    raise NotImplementedError


register("pdv.script.register", handle_script_register)
