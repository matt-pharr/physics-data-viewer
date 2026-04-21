"""
pdv.handlers.project — Handlers for PDV project messages.

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

from typing import Any, Callable

from pdv.handlers import register


def _count_nodes(tree: "Any") -> int:
    """Count total nodes in a tree recursively (no I/O)."""
    from pdv.tree import PDVTree  # noqa: PLC0415

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
    from pdv.errors import PDVSerializationError  # noqa: PLC0415
    from pdv.serialization import (  # noqa: PLC0415
        pickle_fallback_node,
        serialize_node,
    )
    from pdv.tree import PDVTree  # noqa: PLC0415
    import logging  # noqa: PLC0415

    log = logging.getLogger("pdv")

    if counter is None:
        counter = [0]

    nodes = []
    for key in dict.keys(tree):
        path = f"{prefix}.{key}" if prefix else key
        value = dict.__getitem__(tree, key)
        # Super-fallback: if serialize_node refuses this value for any reason,
        # fall back to an unconditional pickle so project.save never fails on
        # a single unrepresentable leaf. See plan §2a and pickle_fallback_node.
        try:
            descriptor = serialize_node(
                path,
                value,
                save_dir,
                trusted=True,
                source_dir=working_dir or save_dir,
            )
        except PDVSerializationError as exc:
            log.warning(
                "project.save: falling back to pickle for node '%s' (%s): %s",
                path,
                type(value).__name__,
                exc,
            )
            descriptor = pickle_fallback_node(path, value, save_dir)
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
        elif descriptor.get("metadata", {}).get("composite") and isinstance(value, dict):
            # Composite plain dict (not a PDVTree): recurse to emit per-leaf
            # descriptors. The recursive call accepts any dict-like because
            # it iterates via dict.keys(), and per-leaf fallback applies to
            # children too.
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


def _purge_orphaned_tree_files(save_dir: str, nodes: list[dict]) -> None:
    """Remove ``<save_dir>/tree/<uuid>/`` directories not referenced by *nodes*.

    Data nodes (ndarray, DataFrame, custom-serialized objects, etc.) receive a
    fresh UUID on every save because the value itself has no stable identity.
    Without cleanup, each save leaves the previous UUID directory behind as an
    orphan.  This function removes those orphans after ``tree-index.json`` has
    been written so the save directory doesn't grow unboundedly.

    File-backed PDV nodes (scripts, notes, libs, etc.) reuse their UUID across
    saves and will always appear in *nodes*, so they are never purged.
    """
    import logging  # noqa: PLC0415
    import os  # noqa: PLC0415
    import shutil  # noqa: PLC0415

    log = logging.getLogger("pdv")

    tree_dir = os.path.join(save_dir, "tree")
    if not os.path.isdir(tree_dir):
        return

    referenced_uuids: set[str] = set()
    for node in nodes:
        node_uuid = node.get("uuid", "")
        if node_uuid:
            referenced_uuids.add(node_uuid)
        storage = node.get("storage", {})
        storage_uuid = storage.get("uuid", "")
        if storage_uuid:
            referenced_uuids.add(storage_uuid)

    try:
        entries = os.listdir(tree_dir)
    except OSError:
        return

    for entry in entries:
        if entry in referenced_uuids:
            continue
        orphan_path = os.path.join(tree_dir, entry)
        if not os.path.isdir(orphan_path):
            continue
        try:
            shutil.rmtree(orphan_path)
        except OSError as exc:
            log.debug("Failed to remove orphaned tree dir %s: %s", orphan_path, exc)


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

    1. It is a :class:`~pdv.tree.PDVFile` (script, lib, gui, namelist).
    2. Its ``source_rel_path`` attribute is non-empty.
    3. It lives beneath a :class:`~pdv.tree.PDVModule` ancestor
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
    from pdv.tree import PDVFile, PDVModule, PDVTree  # noqa: PLC0415

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
    from pdv.serialization import (  # noqa: PLC0415
        node_preview,
        detect_kind,
    )
    from pdv.tree import PDVFile, PDVModule, PDVTree  # noqa: PLC0415

    def _descriptor_for(
        rel_path: str,
        key: str,
        parent_rel: str,
        value: "Any",
    ) -> dict:
        """Build a single module-rooted node descriptor.

        For file-backed children we store ``uuid`` and ``filename`` in
        the descriptor so the reload path can reconstruct the node.
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
            format_map = {
                "script": "py_script",
                "lib": "py_lib",
                "gui": "gui_json",
                "namelist": "namelist",
                "markdown": "markdown",
            }
            storage = {
                "backend": "local_file",
                "uuid": value.uuid,
                "filename": value.filename,
                "format": format_map.get(kind, "file"),
            }
            descriptor["uuid"] = value.uuid
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


def _early_module_setup(
    nodes: list[dict], save_dir: str, working_dir: str
) -> None:
    """Wire module libs into ``sys.path`` and import entry points early.

    Called between Pass 1 (containers) and Pass 2 (leaves) of
    ``load_tree_index`` during project load. Pass 2 hasn't run yet so
    ``PDVLib`` objects don't exist in the tree — instead we scan the raw
    node descriptor list for ``lib`` entries and compute their filesystem
    paths from uuid + filename directly.

    Entry points are read from ``<save_dir>/modules/<module_id>/pdv-module.json``.
    Failures are logged but never abort the load — the worst case is the
    same error the user would have seen before this early-setup path existed.
    """
    import importlib  # noqa: PLC0415
    import json as _json  # noqa: PLC0415
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    import warnings  # noqa: PLC0415

    # Collect module_ids from module-type nodes, and lib paths from lib-type
    # nodes. A lib node's path prefix tells us which module it belongs to
    # (e.g. "n_pendulum.lib.n_pendulum" → module alias "n_pendulum").
    module_ids: dict[str, str] = {}  # alias → module_id
    lib_dirs: set[str] = set()

    for node in nodes:
        node_type = node.get("type", "")
        node_path = node.get("path", "")

        if node_type == "module":
            meta = node.get("metadata", {})
            storage = node.get("storage", {})
            old_meta = storage.get("value", {})
            module_id = meta.get(
                "module_id", old_meta.get("module_id", "")
            )
            if module_id:
                module_ids[node_path] = module_id

        elif node_type == "lib":
            node_uuid = node.get("uuid", node.get("storage", {}).get("uuid", ""))
            filename = node.get("storage", {}).get("filename", "")
            if node_uuid and filename and working_dir:
                lib_file = os.path.join(working_dir, "tree", node_uuid, filename)
                parent_dir = os.path.dirname(lib_file)
                if parent_dir:
                    lib_dirs.add(parent_dir)

    # Wire lib directories into sys.path.
    for lib_dir in lib_dirs:
        if lib_dir not in sys.path:
            sys.path.insert(1, lib_dir)

    # Import entry points for each module.
    for alias, module_id in module_ids.items():
        manifest_path = os.path.join(
            save_dir, "modules", module_id, "pdv-module.json"
        )
        if not os.path.isfile(manifest_path):
            continue
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest = _json.load(fh)
        except Exception:  # noqa: BLE001
            continue

        entry_point = manifest.get("entry_point")
        if not entry_point:
            continue

        try:
            importlib.import_module(entry_point)
        except Exception as exc:  # noqa: BLE001
            warnings.warn(
                f"Early module setup: failed to import entry point "
                f"'{entry_point}' for module '{module_id}': {exc}"
            )


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

    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

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

    from pdv.tree_loader import load_tree_index  # noqa: PLC0415

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

    def _setup_modules_before_leaves() -> None:
        """Import module entry points so custom serializers are registered
        before Pass 2 deserializes data nodes."""
        _early_module_setup(nodes, save_dir, working_dir)

    load_tree_index(
        tree,
        nodes,
        on_progress=_emit_load_progress,
        conflict_strategy="replace",
        working_dir=working_dir,
        between_passes=_setup_modules_before_leaves,
    )

    os.chdir(os.path.expanduser("~"))
    node_count = len(nodes)

    from pdv.checksum import tree_checksum  # noqa: PLC0415

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

    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

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

    _purge_orphaned_tree_files(save_dir, nodes)

    from pdv.checksum import tree_checksum  # noqa: PLC0415

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
