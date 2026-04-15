"""
pdv_kernel.handlers.project — Handlers for PDV project messages.

Handles:
- ``pdv.project.load``: load a project from a save directory. Reads
  ``tree-index.json``, rebuilds the in-memory tree structure, sends
  ``pdv.project.loaded`` push.
- ``pdv.project.save``: serialize the current tree to a save directory.
  Sends ``pdv.project.save.response`` with node count and checksum.

See Also
--------
ARCHITECTURE.md §4.2 (project load sequence), §8 (save and load)
"""

from __future__ import annotations

from pdv_kernel.handlers import register
from pdv_kernel import log


def _count_nodes(tree: "Any") -> int:
    """Count total nodes in a tree recursively (no I/O)."""
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

    count = 0
    for key in dict.keys(tree):
        count += 1
        value = dict.__getitem__(tree, key)
        if isinstance(value, PDVTree):
            count += _count_nodes(value)
    return count


def _collect_nodes(
    tree: "Any",
    save_dir: str,
    prefix: str = "",
    *,
    working_dir: str = "",
    on_progress: "Callable[[int], None] | None" = None,
    counter: "list[int] | None" = None,
) -> list:
    """Recursively serialize tree nodes and return descriptor list.

    Parameters
    ----------
    tree : PDVTree
        The subtree to serialize.
    save_dir : str
        The save directory to write data files to.
    prefix : str
        The dot-separated path prefix for the current subtree.
    working_dir : str
        The kernel working directory where source files live.
    on_progress : callable, optional
        Called with current node count after each node is serialized.
    counter : list, optional
        Mutable single-element list tracking the running count across recursion.

    Returns
    -------
    list
        List of node descriptor dicts.
    """
    from pdv_kernel.serialization import serialize_node  # noqa: PLC0415
    from pdv_kernel.tree import PDVTree  # noqa: PLC0415

    if counter is None:
        counter = [0]

    nodes = []
    for key in dict.keys(tree):
        path = f"{prefix}.{key}" if prefix else key
        value = dict.__getitem__(tree, key)
        descriptor = serialize_node(
            path,
            value,
            save_dir,
            trusted=True,
            source_dir=working_dir or save_dir,
        )
        nodes.append(descriptor)
        counter[0] += 1
        if on_progress is not None:
            on_progress(counter[0])
        if isinstance(value, PDVTree):
            nodes.extend(
                _collect_nodes(
                    value,
                    save_dir,
                    prefix=path,
                    working_dir=working_dir,
                    on_progress=on_progress,
                    counter=counter,
                )
            )
    return nodes


def _collect_module_owned_files(
    tree: "Any",
    working_dir: str,
    *,
    current_module_id: str = "",
) -> list:
    """Walk the tree and return file-backed nodes that belong to a PDVModule.

    Used by the ``pdv.project.save`` handler to let the main process mirror
    edited working-dir files back into ``<saveDir>/modules/<id>/<source_rel_path>``.
    See ARCHITECTURE.md §5.13 and the #140 module editing workflow plan §3.

    A node is emitted only when all three conditions hold:

    1. It is a :class:`~pdv_kernel.tree.PDVFile` (script, lib, gui, namelist).
    2. Its ``source_rel_path`` attribute is non-empty.
    3. It lives beneath a :class:`~pdv_kernel.tree.PDVModule` ancestor
       (so ``current_module_id`` is known), or its own ``module_id``
       attribute identifies a module.

    Parameters
    ----------
    tree : PDVTree
        Subtree to walk.
    working_dir : str
        Kernel working directory — used to resolve each node's absolute
        on-disk path so the main process can open the file directly.
    current_module_id : str
        Module id inherited from the nearest ancestor ``PDVModule`` during
        the recursive walk. Empty at the tree root.

    Returns
    -------
    list of dict
        Entries of the form
        ``{"module_id": ..., "source_rel_path": ..., "workdir_path": ...}``.
    """
    from pdv_kernel.tree import PDVFile, PDVModule, PDVTree  # noqa: PLC0415

    import os  # noqa: PLC0415

    results: list = []
    for key in dict.keys(tree):
        value = dict.__getitem__(tree, key)
        if isinstance(value, PDVModule):
            # Entering a module subtree — children inherit this module's id.
            child_mod_id = value.module_id
            results.extend(
                _collect_module_owned_files(
                    value,
                    working_dir,
                    current_module_id=child_mod_id,
                )
            )
        elif isinstance(value, PDVTree):
            results.extend(
                _collect_module_owned_files(
                    value,
                    working_dir,
                    current_module_id=current_module_id,
                )
            )
        elif isinstance(value, PDVFile):
            source_rel = getattr(value, "source_rel_path", None)
            if not source_rel:
                continue
            # Prefer the nearest ancestor PDVModule's id over the node's
            # own module_id field — the ancestor is the authority on which
            # module directory the file should land in.
            mod_id = current_module_id or getattr(value, "_module_id", "") or ""
            if not mod_id:
                continue
            workdir_path = value.resolve_path(working_dir)
            if not os.path.isabs(workdir_path):
                workdir_path = os.path.join(working_dir, workdir_path)
            results.append(
                {
                    "module_id": mod_id,
                    "source_rel_path": source_rel,
                    "workdir_path": workdir_path,
                }
            )
    return results


def _collect_module_manifests(tree: "Any") -> list:
    """Walk the top of the tree and emit one manifest entry per PDVModule.

    Each entry carries the module's identity metadata plus a list of
    ``module-index.json``-style descriptors describing the module's
    subtree content. The main process consumes this list at save time
    (``ipc-register-project.ts``) to write ``pdv-module.json`` and
    ``module-index.json`` into ``<saveDir>/modules/<id>/``.

    Why we rebuild descriptors instead of reusing ``tree-index.json``
    entries: tree-index.json stores paths **prefixed with the module
    alias** (e.g. ``toy.scripts.hello``) and workdir-rooted storage
    paths (e.g. ``toy/scripts/hello.py``). A reloadable module-index
    needs paths **relative to the module root** (``scripts.hello`` and
    ``scripts/hello.py``) so that ``bindImportedModule`` can re-prefix
    them at the next import time under whatever alias the user picks.

    See ARCHITECTURE.md §5.13 and the #140 workflow plan §7.

    Parameters
    ----------
    tree : PDVTree
        Root tree — only top-level ``PDVModule`` children are considered.

    Returns
    -------
    list of dict
        One entry per module::

            {
                "module_id": "toy",
                "name": "Toy",
                "version": "0.1.0",
                "description": "...",
                "language": "python",
                "dependencies": [...],
                "entries": [<node descriptor>, ...],
            }
    """
    from pdv_kernel.serialization import (  # noqa: PLC0415
        node_preview,
        detect_kind,
        KIND_FOLDER,
        KIND_MODULE,
    )
    from pdv_kernel.tree import PDVFile, PDVModule, PDVTree  # noqa: PLC0415

    def _descriptor_for(
        rel_path: str,
        key: str,
        parent_rel: str,
        value: "Any",
    ) -> dict:
        """Build a single module-rooted node descriptor.

        For file-backed children we re-use the file's ``source_rel_path``
        (set by the bind path / ``tree:create*`` handlers) as the
        descriptor's ``storage.relative_path``, so on reload the
        bindImportedModule v4 remap loop can re-prefix it with the new
        alias.
        """
        kind = detect_kind(value)
        preview = node_preview(value, kind)
        descriptor: dict = {
            "id": rel_path,
            "path": rel_path,
            "key": key,
            "parent_path": parent_rel,
            "type": kind,
            "has_children": isinstance(value, PDVTree),
            "lazy": False,
        }

        if isinstance(value, PDVModule):
            descriptor["storage"] = {
                "backend": "inline",
                "format": "module_meta",
                "value": {
                    "module_id": value.module_id,
                    "name": value.name,
                    "version": value.version,
                },
            }
            descriptor["metadata"] = {
                "module_id": value.module_id,
                "name": value.name,
                "version": value.version,
                "preview": preview,
            }
            return descriptor

        if isinstance(value, PDVTree):
            descriptor["storage"] = {"backend": "none", "format": "none"}
            descriptor["metadata"] = {"preview": preview}
            return descriptor

        if isinstance(value, PDVFile):
            # Module-root-relative path is authoritative here — it's the
            # one we care about on reload. Fall back to the stored
            # relative_path when ``source_rel_path`` hasn't been set
            # (shouldn't happen for module-owned files under workflow
            # A/B, but keep the flow robust).
            rel_storage = getattr(value, "source_rel_path", None) or value.relative_path
            format_map = {
                "script": "py_script",
                "lib": "py_lib",
                "gui": "gui_json",
                "namelist": "namelist",
                "markdown": "markdown",
            }
            storage = {
                "backend": "local_file",
                "relative_path": rel_storage,
                "format": format_map.get(kind, "file"),
            }
            meta: dict = {"preview": preview}
            # Carry the authoring-time ``source_rel_path`` on the
            # descriptor too (for symmetry with how the bind path
            # re-injects it). See tree_loader.py.
            if getattr(value, "source_rel_path", None):
                descriptor["source_rel_path"] = value.source_rel_path
            # Per-kind metadata so the reload path can reconstruct the
            # right subclass via load_tree_index.
            if kind == "script":
                meta["language"] = getattr(value, "language", "python")
                meta["doc"] = getattr(value, "doc", None)
                if getattr(value, "_module_id", None):
                    meta["module_id"] = value._module_id
            elif kind == "lib":
                meta["language"] = "python"
                if getattr(value, "module_id", None):
                    meta["module_id"] = value.module_id
            elif kind == "gui":
                meta["language"] = "json"
                if getattr(value, "module_id", None):
                    meta["module_id"] = value.module_id
            elif kind == "namelist":
                meta["language"] = "namelist"
                meta["namelist_format"] = getattr(value, "format", "auto")
                if getattr(value, "module_id", None):
                    meta["module_id"] = value.module_id
            descriptor["storage"] = storage
            descriptor["metadata"] = meta
            return descriptor

        # Generic / data nodes — pass through a minimal descriptor.
        # Workflow B's data-packaging path (serializing ndarray/dataframe
        # values under a module into module-local tree/data files) is a
        # later enhancement; for this pass we emit the node with a
        # folder-like shape so bindImportedModule doesn't choke.
        descriptor["storage"] = {"backend": "none", "format": "none"}
        descriptor["metadata"] = {"preview": preview}
        return descriptor

    def _walk(
        subtree: "Any",
        parent_rel: str,
        entries: list,
    ) -> None:
        for child_key in dict.keys(subtree):
            child_value = dict.__getitem__(subtree, child_key)
            child_rel = f"{parent_rel}.{child_key}" if parent_rel else child_key
            entries.append(
                _descriptor_for(child_rel, child_key, parent_rel, child_value)
            )
            if isinstance(child_value, PDVTree) and not isinstance(
                child_value, PDVModule
            ):
                _walk(child_value, child_rel, entries)

    results: list = []
    for key in dict.keys(tree):
        value = dict.__getitem__(tree, key)
        if not isinstance(value, PDVModule):
            continue
        entries: list = []
        _walk(value, "", entries)
        results.append(
            {
                "module_id": value.module_id,
                "name": value.name,
                "version": value.version,
                "description": getattr(value, "description", ""),
                "language": getattr(value, "language", "python"),
                "dependencies": list(getattr(value, "_dependencies", []) or []),
                "entries": entries,
            }
        )
    return results


def handle_project_load(msg: dict) -> None:
    """Handle the ``pdv.project.load`` message.

    Loads a project from a save directory. After this handler completes,
    the kernel sends a ``pdv.project.loaded`` push notification (no
    ``in_reply_to``).

    Expected payload
    ----------------
    .. code-block:: json

        { "save_dir": "/path/to/project" }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import json
    import os

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    save_dir = payload.get("save_dir", "")

    if not save_dir or not os.path.isdir(save_dir):
        send_error(
            "pdv.project.load.response",
            "project.invalid_save_dir",
            f"save_dir does not exist or is not a directory: '{save_dir}'",
            in_reply_to=msg_id,
        )
        return

    tree_index_path = os.path.join(save_dir, "tree-index.json")
    if not os.path.exists(tree_index_path):
        send_error(
            "pdv.project.load.response",
            "project.missing_tree_index",
            f"tree-index.json not found in save directory: '{save_dir}'",
            in_reply_to=msg_id,
        )
        return

    try:
        with open(tree_index_path, "r", encoding="utf-8") as fh:
            nodes = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        send_error(
            "pdv.project.load.response",
            "project.corrupt_tree_index",
            f"Failed to parse tree-index.json: {exc}",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.project.load.response",
            "project.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    # Clear existing in-memory tree
    for k in list(dict.keys(tree)):
        dict.__delitem__(tree, k)
    tree._set_save_dir(save_dir)

    working_dir = tree._working_dir or save_dir

    from pdv_kernel.tree_loader import load_tree_index  # noqa: PLC0415

    def _emit_load_progress(current: int, total: int) -> None:
        if current % 5 == 0 or current == total:
            send_message(
                "pdv.progress",
                {
                    "operation": "load",
                    "phase": "Rebuilding tree",
                    "current": current,
                    "total": total,
                },
            )

    load_tree_index(
        tree,
        nodes,
        on_progress=_emit_load_progress,
        conflict_strategy="replace",
        working_dir=working_dir,
        inject_lib_sys_path=True,
    )

    os.chdir(os.path.expanduser("~"))
    node_count = len(nodes)

    from pdv_kernel.checksum import tree_checksum  # noqa: PLC0415

    post_load_checksum = tree_checksum(tree)

    send_message(
        "pdv.project.load.response",
        {"node_count": node_count, "post_load_checksum": post_load_checksum},
        in_reply_to=msg_id,
    )
    # Send pdv.project.loaded push notification (no in_reply_to)
    send_message(
        "pdv.project.loaded",
        {"node_count": node_count},
    )


def handle_project_save(msg: dict) -> None:
    """Handle the ``pdv.project.save`` message.

    Serializes the entire tree to the save directory. Writes data files
    and ``tree-index.json``. Sends ``pdv.project.save.response`` with
    a node count and checksum of ``tree-index.json``.

    Expected payload
    ----------------
    .. code-block:: json

        { "save_dir": "/path/to/project" }

    Response payload
    ----------------
    .. code-block:: json

        { "node_count": 42, "checksum": "<sha256-of-tree-index.json>" }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import json
    import os

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    save_dir = payload.get("save_dir", "")

    if not save_dir:
        send_error(
            "pdv.project.save.response",
            "project.missing_save_dir",
            "save_dir is required in the pdv.project.save payload",
            in_reply_to=msg_id,
        )
        return

    os.makedirs(os.path.join(save_dir, "tree"), exist_ok=True)

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.project.save.response",
            "project.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    working_dir = tree._working_dir or save_dir

    total = _count_nodes(tree)

    def _emit_save_progress(current: int) -> None:
        if current % 5 == 0 or current == total:
            send_message(
                "pdv.progress",
                {
                    "operation": "save",
                    "phase": "Serializing",
                    "current": current,
                    "total": total,
                },
            )

    try:
        nodes = _collect_nodes(
            tree,
            save_dir,
            working_dir=working_dir,
            on_progress=_emit_save_progress,
        )
    except Exception as exc:  # noqa: BLE001
        send_error(
            "pdv.project.save.response",
            "project.serialization_error",
            str(exc),
            in_reply_to=msg_id,
        )
        return

    index_data = json.dumps(nodes, indent=2, default=str)
    index_path = os.path.join(save_dir, "tree-index.json")
    tmp_path = index_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(index_data)
    os.replace(tmp_path, index_path)

    from pdv_kernel.checksum import tree_checksum  # noqa: PLC0415

    checksum = tree_checksum(tree)

    # Enumerate module-owned files so the main process can mirror their
    # working-dir contents back into <saveDir>/modules/<id>/<source_rel_path>.
    # See ARCHITECTURE.md §5.13 and the #140 workflow plan §3.
    module_owned_files = _collect_module_owned_files(tree, working_dir)
    # Collect per-module manifests for writing pdv-module.json +
    # module-index.json into <saveDir>/modules/<id>/. See plan §7.
    module_manifests = _collect_module_manifests(tree)

    send_message(
        "pdv.project.save.response",
        {
            "node_count": len(nodes),
            "checksum": checksum,
            "module_owned_files": module_owned_files,
            "module_manifests": module_manifests,
        },
        in_reply_to=msg_id,
    )


register("pdv.project.load", handle_project_load)
register("pdv.project.save", handle_project_save)
