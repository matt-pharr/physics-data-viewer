"""
pdv_kernel.tree_loader — Shared two-pass tree-index loader.

Both ``pdv.project.load`` and ``pdv.module.register`` reconstruct a
:class:`~pdv_kernel.tree.PDVTree` subtree from a list of node descriptors
serialized to a ``tree-index.json``-style array. ARCHITECTURE.md §3.4
explicitly states that module register uses "the same two-pass logic as
project load" — this module is the canonical implementation, so the two
handlers cannot drift.

The two passes are:

1. **Containers** (``folder``, ``module``) — created first so child nodes
   always have a valid parent path to insert into.
2. **Leaves** (``script``, ``markdown``, ``gui``, ``namelist``, ``lib``,
   inline values, file-backed values) — populated second.

Divergent details between the two callers are exposed as named arguments:

- ``alias_prefix`` — module register prefixes every node path with the
  alias (e.g. ``"n_pendulum.scripts.run"``); project load passes ``""``.
- ``on_progress`` — project load emits ``pdv.progress`` messages every 5
  nodes; module register is silent.
- ``conflict_strategy`` — project load **replaces** unconditionally
  (the tree is cleared before the loader runs); module register **skips**
  existing nodes so that user data already present from a prior project
  load is not overwritten.
- ``patch_module_id_on_skip`` — when set, module register patches the
  ``_module_id`` attribute of an already-existing :class:`PDVScript` so the
  dependency pre-flight check in :meth:`PDVScript.run` can find the parent
  :class:`PDVModule`.
- ``module_id_default`` — fallback ``module_id`` for ``script`` nodes when
  the on-disk metadata is missing it.
- ``inject_lib_sys_path`` — project load adds the parent directory of each
  ``PDVLib`` file to ``sys.path`` so the library is importable; module
  register defers ``sys.path`` injection to ``handle_modules_setup`` via
  the ``lib_dir`` field, so the loader does not touch ``sys.path``.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue), §4.2 (project load sequence)
pdv_kernel.handlers.project — pdv.project.load handler
pdv_kernel.handlers.modules — pdv.module.register handler
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable, Literal


# A node-fully-loaded callback signature; receives (current_index, total_nodes).
ProgressCallback = Callable[[int, int], None]
ConflictStrategy = Literal["replace", "skip"]


def load_tree_index(
    tree: Any,
    nodes: list[dict],
    *,
    alias_prefix: str = "",
    on_progress: ProgressCallback | None = None,
    conflict_strategy: ConflictStrategy = "replace",
    patch_module_id_on_skip: str | None = None,
    module_id_default: str = "",
    working_dir: str = "",
    inject_lib_sys_path: bool = False,
) -> None:
    """Mount a tree-index node list into ``tree`` using the two-pass algorithm.

    Parameters
    ----------
    tree : PDVTree
        The root tree to mount nodes into. Mutations bypass change
        notifications via :meth:`PDVTree.set_quiet`.
    nodes : list[dict]
        Node descriptors as returned by :func:`serialize_node` (or as stored
        in ``tree-index.json``).
    alias_prefix : str
        Prefix prepended to each node's ``path`` before insertion. Empty
        string for project load; the module alias for module register.
    on_progress : callable, optional
        Invoked once per leaf node with ``(current_index, total)``. Used
        by project load to emit ``pdv.progress`` push messages.
    conflict_strategy : {"replace", "skip"}
        How to handle nodes that already exist at the target path. Project
        load uses ``"replace"`` (the tree is cleared first); module register
        uses ``"skip"`` so user data is preserved across re-imports.
    patch_module_id_on_skip : str or None
        When set, an already-existing :class:`PDVScript` at a leaf path has
        its ``_module_id`` patched to this value before being skipped. Used
        by module register to keep dependency pre-flight checks working
        when reloading a project that already has the module's scripts
        registered.
    module_id_default : str
        Fallback ``module_id`` for ``script`` nodes when the on-disk
        metadata is missing it.
    working_dir : str
        Working directory used to resolve relative paths during
        deserialization and (when ``inject_lib_sys_path`` is True) lib
        ``sys.path`` injection.
    inject_lib_sys_path : bool
        When True, the parent directory of each ``PDVLib`` file is added
        to ``sys.path``. Project load uses True; module register uses
        False because ``handle_modules_setup`` handles this separately.
    """
    # Local imports to avoid circular dependencies — tree.py imports nothing
    # from this module, so importing tree.py here is safe.
    from pdv_kernel.tree import (  # noqa: PLC0415
        PDVGui,
        PDVLib,
        PDVModule,
        PDVNamelist,
        PDVNote,
        PDVScript,
        PDVTree,
    )
    from pdv_kernel.serialization import deserialize_node  # noqa: PLC0415

    def _full_path(node_path_rel: str) -> str:
        if alias_prefix:
            return f"{alias_prefix}.{node_path_rel}"
        return node_path_rel

    def _node_exists(full_path: str) -> tuple[bool, Any]:
        try:
            value = tree[full_path]
            return value is not None, value
        except (KeyError, TypeError):
            return False, None

    # ── Pass 1: containers ───────────────────────────────────────────────
    for node in nodes:
        node_path_rel = node.get("path", "")
        if not node_path_rel:
            continue
        node_type = node.get("type", "")
        meta = node.get("metadata", {})
        full_path = _full_path(node_path_rel)

        if conflict_strategy == "skip":
            exists, _ = _node_exists(full_path)
            if exists:
                continue

        if node_type == "folder":
            folder = PDVTree()
            folder._working_dir = tree._working_dir
            folder._save_dir = tree._save_dir
            tree.set_quiet(full_path, folder)
        elif node_type == "module":
            storage = node.get("storage", {})
            old_meta = storage.get("value", {})
            mod = PDVModule(
                module_id=meta.get("module_id", old_meta.get("module_id", module_id_default)),
                name=meta.get("name", old_meta.get("name", "")),
                version=meta.get("version", old_meta.get("version", "")),
            )
            mod._working_dir = tree._working_dir
            mod._save_dir = tree._save_dir
            tree.set_quiet(full_path, mod)

    # ── Pass 2: leaves ───────────────────────────────────────────────────
    total = len(nodes)
    for index, node in enumerate(nodes, start=1):
        node_path_rel = node.get("path", "")
        if not node_path_rel:
            if on_progress is not None:
                on_progress(index, total)
            continue
        node_type = node.get("type", "")
        if node_type in ("folder", "module"):
            if on_progress is not None:
                on_progress(index, total)
            continue

        full_path = _full_path(node_path_rel)
        storage = node.get("storage", {})
        backend = storage.get("backend", "")
        meta = node.get("metadata", {})

        if conflict_strategy == "skip":
            exists, existing_value = _node_exists(full_path)
            if exists:
                if (
                    patch_module_id_on_skip is not None
                    and node_type == "script"
                    and isinstance(existing_value, PDVScript)
                ):
                    existing_value._module_id = patch_module_id_on_skip
                if on_progress is not None:
                    on_progress(index, total)
                continue

        rel_path = storage.get("relative_path", "")
        # source_rel_path is the path of this file relative to its owning
        # module root (e.g. "scripts/run.py"). Set by the module bind path
        # for module-owned files and re-read here so it survives
        # save/load cycles. See ARCHITECTURE.md §5.13.
        src_rel = node.get("source_rel_path")

        if node_type == "script":
            language = meta.get("language", node.get("language", "python"))
            doc = meta.get("doc")
            mod_id = meta.get("module_id", module_id_default)
            tree.set_quiet(full_path, PDVScript(
                relative_path=rel_path,
                language=language,
                doc=doc,
                module_id=mod_id,
                source_rel_path=src_rel,
            ))
        elif node_type == "markdown":
            title = meta.get("title")
            tree.set_quiet(full_path, PDVNote(
                relative_path=rel_path,
                title=title,
            ))
        elif node_type == "gui":
            mod_id = meta.get("module_id", node.get("module_id", module_id_default))
            gui_node = PDVGui(
                relative_path=rel_path,
                module_id=mod_id,
                source_rel_path=src_rel,
            )
            tree.set_quiet(full_path, gui_node)
            # Attach gui reference to parent PDVModule if applicable.
            parts = full_path.split(".")
            if len(parts) > 1:
                parent_path = ".".join(parts[:-1])
                try:
                    parent = tree[parent_path]
                    if isinstance(parent, PDVModule):
                        parent.gui = gui_node
                except (KeyError, AttributeError):
                    pass
        elif node_type == "namelist":
            mod_id = meta.get("module_id", node.get("module_id", module_id_default))
            namelist_format = meta.get(
                "namelist_format", node.get("namelist_format", "auto")
            )
            tree.set_quiet(full_path, PDVNamelist(
                relative_path=rel_path,
                format=namelist_format,
                module_id=mod_id,
                source_rel_path=src_rel,
            ))
        elif node_type == "lib":
            mod_id = meta.get("module_id", node.get("module_id", module_id_default))
            tree.set_quiet(full_path, PDVLib(
                relative_path=rel_path,
                module_id=mod_id,
                source_rel_path=src_rel,
            ))
            if inject_lib_sys_path:
                abs_path = os.path.join(working_dir, rel_path) if rel_path else ""
                if abs_path:
                    parent_dir = os.path.dirname(abs_path)
                    if parent_dir and parent_dir not in sys.path:
                        sys.path.insert(1, parent_dir)
        elif backend == "inline":
            tree.set_quiet(full_path, storage.get("value"))
        elif backend == "local_file":
            value = deserialize_node(storage, working_dir, trusted=True)
            tree.set_quiet(full_path, value)

        if on_progress is not None:
            on_progress(index, total)
