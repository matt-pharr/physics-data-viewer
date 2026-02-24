"""
pdv_kernel.handlers.tree — Handlers for PDV tree query messages.

Handles:
- ``pdv.tree.list``: return the children of a tree node at a given path.
- ``pdv.tree.get``: return the value (or metadata) of a specific node.

See Also
--------
ARCHITECTURE.md §3.4 (tree messages), §7 (tree data model)
"""

from __future__ import annotations

from pdv_kernel.handlers import register


def handle_tree_list(msg: dict) -> None:
    """Handle the ``pdv.tree.list`` message.

    Returns the children of the tree node at the given path as an array
    of node descriptor dicts.

    Expected payload
    ----------------
    .. code-block:: json

        { "path": "data.waveforms" }

    An empty ``path`` (or ``""``) returns the top-level children of the
    tree root.

    Response payload
    ----------------
    .. code-block:: json

        { "nodes": [ <node-descriptor>, ... ] }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    # TODO: implement in Step 2
    raise NotImplementedError


def handle_tree_get(msg: dict) -> None:
    """Handle the ``pdv.tree.get`` message.

    Returns the value or metadata for a specific tree node. If the node
    is lazy, this triggers a transparent load from the save directory.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "path": "data.waveforms.ch1",
            "mode": "value"
        }

    ``mode`` is one of ``'metadata'``, ``'preview'``, ``'value'``,
    ``'slice'`` (see ARCHITECTURE.md §7).

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    # TODO: implement in Step 2
    raise NotImplementedError


register("pdv.tree.list", handle_tree_list)
register("pdv.tree.get", handle_tree_get)
