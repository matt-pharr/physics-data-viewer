"""
pdv_kernel.handlers.modules — Handlers for module namespace setup and handler invocation.

Handles:
- ``pdv.modules.setup``: add module install paths to sys.path and run entry points.
- ``pdv.handler.invoke``: dispatch a registered handler for a tree node.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
pdv_kernel.modules — handler registry and decorator
"""

from __future__ import annotations

import importlib
import sys

from pdv_kernel.handlers import register


def handle_module_register(msg: dict) -> None:
    """Handle the ``pdv.module.register`` message.

    Creates a :class:`~pdv_kernel.tree.PDVModule` and attaches it to the
    tree at the given alias path.

    For v4 modules, an optional ``module_index`` array may be included in the
    payload.  When present the kernel reconstructs the module's subtree from the
    index using the same two-pass logic as project load, mounting all nodes under
    the alias path.

    Expected payload (minimal)
    --------------------------
    .. code-block:: json

        {
            "path": "n_pendulum",
            "module_id": "n_pendulum",
            "name": "N-Pendulum",
            "version": "2.0.0"
        }

    Expected payload (v4 with index)
    ---------------------------------
    .. code-block:: json

        {
            "path": "n_pendulum",
            "module_id": "n_pendulum",
            "name": "N-Pendulum",
            "version": "2.0.0",
            "module_index": [ ... ]
        }

    Response type: ``pdv.module.register.response``

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415

    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.tree import PDVModule, PDVTree, PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    alias = payload.get("path", "")
    module_id = payload.get("module_id", "")
    name = payload.get("name", "")
    version = payload.get("version", "")
    module_index = payload.get("module_index")
    dependencies = payload.get("dependencies", [])

    if not alias or not module_id:
        send_error(
            "pdv.module.register.response",
            "module.missing_fields",
            "path and module_id are required in pdv.module.register payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.module.register.response",
            "module.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    working_dir = tree._working_dir or ""

    # Create the root PDVModule node at the alias path.
    # If a PDVModule already exists (e.g. from project load), update in-place
    # to preserve any existing children (result data, etc.).
    existing = tree.get(alias)
    if isinstance(existing, PDVModule):
        existing._module_id = module_id
        existing._name = name
        existing._version = version
        existing._dependencies = dependencies or []
    elif isinstance(existing, dict) and len(existing) > 0:
        module_node = PDVModule(module_id=module_id, name=name, version=version,
                                dependencies=dependencies)
        for k, v in existing.items():
            dict.__setitem__(module_node, k, v)
        tree[alias] = module_node
    else:
        tree[alias] = PDVModule(module_id=module_id, name=name, version=version,
                                dependencies=dependencies)

    # v4: mount subtree from module_index (same two-pass logic as project load).
    # When loading a saved project the tree is already populated from
    # tree-index.json before MODULE_REGISTER runs.  Skip nodes that already
    # exist so that user data (e.g. result objects under "outputs") is not
    # overwritten by empty default containers.
    if module_index:
        from pdv_kernel.handlers.project import _set_tree_node  # noqa: PLC0415

        # Pass 1: containers (folder, module)
        for node in module_index:
            node_path_rel = node.get("path", "")
            node_type = node.get("type", "")
            meta = node.get("metadata", {})
            if not node_path_rel:
                continue
            full_path = f"{alias}.{node_path_rel}"

            # Skip if this node already exists (e.g. from project load)
            try:
                existing_node = tree[full_path]
                if existing_node is not None:
                    continue
            except (KeyError, TypeError):
                pass

            if node_type == "folder":
                folder = PDVTree()
                folder._working_dir = tree._working_dir
                folder._save_dir = tree._save_dir
                folder._path_prefix = full_path
                _set_tree_node(tree, full_path, folder)
            elif node_type == "module":
                storage = node.get("storage", {})
                old_meta = storage.get("value", {})
                mod = PDVModule(
                    module_id=meta.get("module_id", old_meta.get("module_id", module_id)),
                    name=meta.get("name", old_meta.get("name", name)),
                    version=meta.get("version", old_meta.get("version", version)),
                )
                mod._working_dir = tree._working_dir
                mod._save_dir = tree._save_dir
                mod._path_prefix = full_path
                _set_tree_node(tree, full_path, mod)

        # Pass 2: leaves
        for node in module_index:
            node_path_rel = node.get("path", "")
            node_type = node.get("type", "")
            storage = node.get("storage", {})
            backend = storage.get("backend", "")
            meta = node.get("metadata", {})
            if not node_path_rel or node_type in ("folder", "module"):
                continue
            full_path = f"{alias}.{node_path_rel}"

            # Skip if this node already exists (e.g. from project load),
            # but patch module_id onto existing scripts so that the
            # dependency pre-flight check in PDVScript.run() can find
            # the parent PDVModule.
            try:
                existing_node = tree[full_path]
                if existing_node is not None:
                    if node_type == "script" and isinstance(existing_node, PDVScript):
                        existing_node._module_id = module_id
                    continue
            except (KeyError, TypeError):
                pass
            rel_path = storage.get("relative_path", "")

            if node_type == "script":
                language = meta.get("language", node.get("language", "python"))
                doc = meta.get("doc")
                _set_tree_node(tree, full_path, PDVScript(
                    relative_path=rel_path,
                    language=language,
                    doc=doc,
                    module_id=module_id,
                ))
            elif node_type == "markdown":
                title = meta.get("title")
                _set_tree_node(tree, full_path, PDVNote(
                    relative_path=rel_path,
                    title=title,
                ))
            elif node_type == "gui":
                mod_id = meta.get("module_id", module_id)
                gui_node = PDVGui(relative_path=rel_path, module_id=mod_id)
                _set_tree_node(tree, full_path, gui_node)
                parts = full_path.split(".")
                if len(parts) > 1:
                    parent_path = ".".join(parts[:-1])
                    try:
                        parent = tree[parent_path]
                        if isinstance(parent, PDVModule):
                            parent.gui = gui_node
                    except Exception:  # noqa: BLE001
                        pass
            elif node_type == "namelist":
                mod_id = meta.get("module_id", module_id)
                namelist_format = meta.get("namelist_format", node.get("namelist_format", "auto"))
                _set_tree_node(tree, full_path, PDVNamelist(
                    relative_path=rel_path,
                    format=namelist_format,
                    module_id=mod_id,
                ))
            elif node_type == "lib":
                mod_id = meta.get("module_id", module_id)
                _set_tree_node(tree, full_path, PDVLib(
                    relative_path=rel_path,
                    module_id=mod_id,
                ))
                # lib_dir sys.path injection is handled separately in
                # handle_modules_setup via the lib_dir field
            elif backend == "inline":
                _set_tree_node(tree, full_path, storage.get("value"))
            elif backend == "local_file":
                from pdv_kernel.serialization import deserialize_node  # noqa: PLC0415
                value = deserialize_node(storage, tree._working_dir or "", trusted=True)
                _set_tree_node(tree, full_path, value)

    send_message(
        "pdv.module.register.response",
        {"path": alias, "module_id": module_id},
        in_reply_to=msg_id,
    )


def handle_modules_setup(msg: dict) -> None:
    """Handle the ``pdv.modules.setup`` message.

    For each module in the payload, adds library directories to ``sys.path``
    and imports the entry point module if specified.

    Supports two path styles:

    - ``lib_dir`` (v4): absolute path to a library directory; added directly.
    - ``lib_paths`` (v1/v2/v3 legacy): list of individual ``.py`` file paths;
      the parent directory of each is added.

    Expected payload (v4)
    ---------------------
    .. code-block:: json

        {
            "modules": [
                {
                    "lib_paths": [],
                    "lib_dir": "/tmp/pdv-xxx/n_pendulum/lib",
                    "entry_point": "n_pendulum"
                }
            ]
        }

    Expected payload (legacy)
    -------------------------
    .. code-block:: json

        {
            "modules": [
                {
                    "lib_paths": ["/tmp/pdv-xxx/n_pendulum/lib/n_pendulum.py"],
                    "entry_point": "n_pendulum"
                }
            ]
        }

    Response payload
    ----------------
    .. code-block:: json

        { "handlers": { "module.Class": "handler_func_name", ... } }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import os  # noqa: PLC0415

    from pdv_kernel.comms import send_message  # noqa: PLC0415
    from pdv_kernel.modules import get_handler_registry  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    modules = payload.get("modules", [])

    for mod_info in modules:
        lib_paths = mod_info.get("lib_paths", [])
        lib_dir = mod_info.get("lib_dir")
        entry_point = mod_info.get("entry_point")

        # v4: add lib_dir directly to sys.path.
        # Do not gate on os.path.isdir — the directory may not exist yet when
        # pdv.modules.setup runs before bindActiveProjectModules copies files.
        # Python handles non-existent sys.path entries gracefully.
        if lib_dir and lib_dir not in sys.path:
            sys.path.insert(1, lib_dir)

        # Legacy: add parent directory of each lib .py file to sys.path.
        for file_path in lib_paths:
            parent_dir = os.path.dirname(file_path)
            if parent_dir and parent_dir not in sys.path:
                sys.path.insert(1, parent_dir)

        if entry_point:
            try:
                importlib.import_module(entry_point)
            except Exception as exc:  # noqa: BLE001
                import warnings  # noqa: PLC0415

                warnings.warn(
                    f"Failed to import module entry point '{entry_point}': {exc}"
                )

    send_message(
        "pdv.modules.setup.response",
        {"handlers": get_handler_registry()},
        in_reply_to=msg_id,
    )


def handle_handler_invoke(msg: dict) -> None:
    """Handle the ``pdv.handler.invoke`` message.

    Looks up the tree node at the given path and dispatches its registered
    handler.

    Expected payload
    ----------------
    .. code-block:: json

        { "path": "data.my_obj" }

    Response payload
    ----------------
    .. code-block:: json

        { "dispatched": true }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv_kernel.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv_kernel.modules import dispatch_handler  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    path = payload.get("path", "")

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.handler.invoke.response",
            "tree.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    if path not in tree:
        send_error(
            "pdv.handler.invoke.response",
            "tree.path_not_found",
            f"No node at path: '{path}'",
            in_reply_to=msg_id,
        )
        return

    try:
        value = tree[path]
    except Exception as exc:
        send_error(
            "pdv.handler.invoke.response",
            "tree.load_error",
            str(exc),
            in_reply_to=msg_id,
        )
        return

    result = dispatch_handler(value, path, tree)
    send_message("pdv.handler.invoke.response", result, in_reply_to=msg_id)


register("pdv.module.register", handle_module_register)
register("pdv.modules.setup", handle_modules_setup)
register("pdv.handler.invoke", handle_handler_invoke)
