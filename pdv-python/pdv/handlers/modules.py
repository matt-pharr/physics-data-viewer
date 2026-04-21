"""
pdv.handlers.modules — Handlers for module namespace setup and handler invocation.

Handles:
- ``pdv.modules.setup``: add module install paths to sys.path and run entry points.
- ``pdv.handler.invoke``: dispatch a registered handler for a tree node.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
pdv.modules — handler registry and decorator
"""

from __future__ import annotations

import importlib
import sys

from pdv.handlers import register


def handle_module_register(msg: dict) -> None:
    """Handle the ``pdv.module.register`` message.

    Creates a :class:`~pdv.tree.PDVModule` and attaches it to the
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
    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.tree import PDVModule  # noqa: PLC0415

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
        module_node = PDVModule(
            module_id=module_id, name=name, version=version, dependencies=dependencies
        )
        for k, v in existing.items():
            dict.__setitem__(module_node, k, v)
        tree[alias] = module_node
    else:
        tree[alias] = PDVModule(
            module_id=module_id, name=name, version=version, dependencies=dependencies
        )

    # v4: mount subtree from module_index (same two-pass logic as project load).
    # When loading a saved project the tree is already populated from
    # tree-index.json before MODULE_REGISTER runs. Skip nodes that already
    # exist so that user data (e.g. result objects under "outputs") is not
    # overwritten by empty default containers. sys.path for lib files is
    # derived inside handle_modules_setup by walking the PDVModule subtree —
    # the loader does not touch sys.path at all.
    if module_index:
        from pdv.tree_loader import load_tree_index  # noqa: PLC0415

        load_tree_index(
            tree,
            module_index,
            alias_prefix=alias,
            conflict_strategy="skip",
            patch_module_id_on_skip=module_id,
            module_id_default=module_id,
            working_dir=working_dir,
        )

    send_message(
        "pdv.module.register.response",
        {"path": alias, "module_id": module_id},
        in_reply_to=msg_id,
    )


def _iter_pdv_libs(container: object):
    """Yield every ``PDVLib`` descendant of ``container``.

    Walks ``PDVTree``, ``PDVModule``, and plain ``dict`` containers
    recursively. The walker deliberately does not assume libs live at any
    particular sub-key (e.g. ``module.lib``) — it finds every ``PDVLib`` in
    the subtree regardless of shape, which keeps it forward-compatible with
    future storage layouts.
    """
    from pdv.tree import PDVLib  # noqa: PLC0415

    if isinstance(container, PDVLib):
        yield container
        return
    if not isinstance(container, dict):
        return
    for child in container.values():
        yield from _iter_pdv_libs(child)


def handle_modules_setup(msg: dict) -> None:
    """Handle the ``pdv.modules.setup`` message.

    For each module alias in the payload, walks the corresponding
    :class:`~pdv.tree.PDVModule` subtree in the live tree, collects
    the parent directory of every :class:`~pdv.tree.PDVLib`
    descendant, dedupes, and inserts each unique parent into ``sys.path``.
    Then imports any specified entry point.

    This is the single owner of module-related ``sys.path`` wiring. Main
    process code must not pre-compute lib directories — the kernel derives
    them from the in-memory tree, which keeps filesystem layout knowledge
    on the side that owns the tree and keeps the setup contract stable
    across storage-layout redesigns.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "modules": [
                { "alias": "n_pendulum", "entry_point": "n_pendulum" },
                { "alias": "ddho" }
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
    import warnings  # noqa: PLC0415

    from pdv.comms import get_pdv_tree, send_message  # noqa: PLC0415
    from pdv.modules import get_handler_registry  # noqa: PLC0415
    from pdv.tree import PDVModule  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    modules = payload.get("modules", [])

    tree = get_pdv_tree()
    working_dir = getattr(tree, "_working_dir", None) if tree is not None else None

    for mod_info in modules:
        alias = mod_info.get("alias")
        entry_point = mod_info.get("entry_point")

        if not alias:
            warnings.warn("pdv.modules.setup entry missing 'alias'; skipping")
            continue

        module_node = tree.get(alias) if tree is not None else None
        if not isinstance(module_node, PDVModule):
            warnings.warn(
                f"pdv.modules.setup: no PDVModule at alias '{alias}'; skipping"
            )
        else:
            seen: set[str] = set()
            for lib in _iter_pdv_libs(module_node):
                abs_path = lib.resolve_path(working_dir)
                parent_dir = os.path.dirname(abs_path)
                if not parent_dir or parent_dir in seen:
                    continue
                seen.add(parent_dir)
                # Do not gate on os.path.isdir — the directory may not
                # exist yet when pdv.modules.setup runs before main-side
                # file copies complete. Python handles non-existent
                # sys.path entries gracefully.
                if parent_dir not in sys.path:
                    sys.path.insert(1, parent_dir)

        if entry_point:
            try:
                importlib.import_module(entry_point)
            except Exception as exc:  # noqa: BLE001
                warnings.warn(
                    f"Failed to import module entry point '{entry_point}': {exc}"
                )

    send_message(
        "pdv.modules.setup.response",
        {"handlers": get_handler_registry()},
        in_reply_to=msg_id,
    )


def handle_module_create_empty(msg: dict) -> None:
    """Handle the ``pdv.module.create_empty`` message.

    Creates a bare :class:`~pdv.tree.PDVModule` at the top of the
    tree and seeds it with three conventional empty ``PDVTree`` children
    (``scripts``, ``lib``, ``plots``). Used by workflow B of issue #140:
    a user starts a new module from scratch inside the app, populates its
    contents via ``tree:createScript`` / ``tree:createLib`` / ``tree:createGui``,
    and exports the result to the global store at save time.

    Intentionally side-effect-free on disk — the main process owns the
    working-dir scaffolding and the project-local ``<saveDir>/modules/<id>/``
    write path. This handler only mutates the in-memory tree.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "id": "toy",
            "name": "Toy",
            "version": "0.1.0",
            "description": "",
            "language": "python"
        }

    Response payload
    ----------------
    .. code-block:: json

        { "path": "toy" }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.tree import PDVModule, PDVTree  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    module_id = payload.get("id", "")
    name = payload.get("name", "") or module_id
    version = payload.get("version", "0.1.0")
    description = payload.get("description", "") or ""
    language = payload.get("language", "python") or "python"

    if not module_id:
        send_error(
            "pdv.module.create_empty.response",
            "module.missing_id",
            "id is required in pdv.module.create_empty payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.module.create_empty.response",
            "module.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    # Reject collisions with any existing top-level tree key — not just
    # PDVModule nodes, since a data/folder node would also block access.
    try:
        _existing = tree[module_id]
        send_error(
            "pdv.module.create_empty.response",
            "module.alias_exists",
            f"Tree path already occupied: {module_id!r}",
            in_reply_to=msg_id,
        )
        return
    except (KeyError, TypeError):
        pass

    module = PDVModule(
        module_id=module_id,
        name=name,
        version=version,
        description=description,
        language=language,
    )
    module._working_dir = tree._working_dir
    module._save_dir = tree._save_dir
    # Seed the three conventional subtrees. These are plain PDVTree
    # containers — the names are a UI convention documented in the
    # workflow B plan; the kernel does not enforce their shape.
    for child_key in ("scripts", "lib", "plots"):
        child = PDVTree()
        child._working_dir = tree._working_dir
        child._save_dir = tree._save_dir
        module[child_key] = child

    tree[module_id] = module

    send_message(
        "pdv.module.create_empty.response",
        {"path": module_id},
        in_reply_to=msg_id,
    )


def handle_module_update(msg: dict) -> None:
    """Handle the ``pdv.module.update`` message.

    Patches mutable fields (``name``, ``version``, ``description``) on an
    existing :class:`~pdv.tree.PDVModule`. Any field omitted from
    the payload is left unchanged. ``module_id`` and ``language`` are
    read-only — creating a new module is the right way to change those.

    Expected payload
    ----------------
    .. code-block:: json

        {
            "alias": "toy",
            "name": "Toy (renamed)",
            "version": "0.2.0",
            "description": "A toy example"
        }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.tree import PDVModule  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    alias = payload.get("alias", "")

    if not alias:
        send_error(
            "pdv.module.update.response",
            "module.missing_alias",
            "alias is required in pdv.module.update payload",
            in_reply_to=msg_id,
        )
        return

    tree = get_pdv_tree()
    if tree is None:
        send_error(
            "pdv.module.update.response",
            "module.no_tree",
            "PDVTree is not initialized",
            in_reply_to=msg_id,
        )
        return

    try:
        node = tree[alias]
    except (KeyError, TypeError):
        send_error(
            "pdv.module.update.response",
            "module.not_found",
            f"No node at path: {alias!r}",
            in_reply_to=msg_id,
        )
        return

    if not isinstance(node, PDVModule):
        send_error(
            "pdv.module.update.response",
            "module.not_a_module",
            f"Node at {alias!r} is not a PDVModule",
            in_reply_to=msg_id,
        )
        return

    if "name" in payload and payload["name"] is not None:
        node.name = str(payload["name"])
    if "version" in payload and payload["version"] is not None:
        node.version = str(payload["version"])
    if "description" in payload and payload["description"] is not None:
        node.description = str(payload["description"])

    send_message(
        "pdv.module.update.response",
        {
            "alias": alias,
            "name": node.name,
            "version": node.version,
            "description": node.description,
        },
        in_reply_to=msg_id,
    )


def handle_module_reload_libs(msg: dict) -> None:
    """Handle the ``pdv.module.reload_libs`` message.

    Reloads every Python module whose ``__file__`` sits under the working
    directory's ``<alias>/lib/`` folder, so that edits to module library
    files are picked up on the next script run without restarting the
    kernel. Called as a preflight before ``script:run`` on a module-owned
    script; see the #140 module editing workflow plan §4.

    Individual ``importlib.reload()`` failures are swallowed and logged
    — a broken lib file should surface at script-run time with a proper
    traceback, not at reload time with a cryptic message.

    Expected payload
    ----------------
    .. code-block:: json

        { "alias": "n_pendulum" }

    Response payload
    ----------------
    .. code-block:: json

        { "reloaded": ["n_pendulum", "..."], "errors": {"bad_lib": "..."} }

    Parameters
    ----------
    msg : dict
        Parsed PDV message envelope.
    """
    import os  # noqa: PLC0415

    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415

    msg_id = msg.get("msg_id")
    payload = msg.get("payload", {})
    alias = payload.get("alias", "")

    if not alias:
        send_error(
            "pdv.module.reload_libs.response",
            "module.missing_alias",
            "alias is required in pdv.module.reload_libs payload",
            in_reply_to=msg_id,
        )
        return

    from pdv.tree import PDVModule  # noqa: PLC0415

    tree = get_pdv_tree()
    working_dir = getattr(tree, "_working_dir", "") if tree is not None else ""

    # Short-circuit if the caller's alias does not correspond to an actual
    # PDVModule in the tree. The ``script:run`` preflight fires this for every
    # run, including plain project scripts, so we must be cheap in the
    # non-module case.
    is_module = False
    if tree is not None:
        try:
            node = tree[alias]
            is_module = isinstance(node, PDVModule)
        except (KeyError, TypeError):
            is_module = False

    # ``<workdir>/tree/<alias>/lib/`` is where bindImportedModule places
    # lib files for v4 modules. For modules authored in-session
    # (workflow B), the same convention applies because the empty-
    # module creation handler seeds the working dir with
    # ``tree/<uuid>/<filename>``. Every file-backed tree node lives
    # under the ``tree/`` subdir (ARCHITECTURE.md §6.1/§6.2), keyed
    # by its UUID so paths are stable across rename/move/save/load.
    #
    # Use realpath on both sides of the comparison: on macOS, ``/var`` is a
    # symlink to ``/private/var``, and a module's ``__file__`` can come back
    # as the un-prefixed form while ``_working_dir`` is the fully-resolved
    # ``/private/var/...`` path (or vice versa). A literal ``startswith``
    # check would fail to match files that live at the same physical path.
    lib_prefix = ""
    if is_module and working_dir:
        try:
            lib_prefix = os.path.realpath(
                os.path.join(working_dir, "tree", alias, "lib")
            )
        except Exception:  # noqa: BLE001
            lib_prefix = ""

    reloaded: list[str] = []
    errors: dict[str, str] = {}

    if lib_prefix:
        # Snapshot sys.modules — reload() mutates it and we don't want to
        # iterate over a live dict that grows during traversal.
        items = list(sys.modules.items())
        for mod_name, mod in items:
            try:
                mod_file = getattr(mod, "__file__", None)
            except Exception:  # noqa: BLE001
                continue
            if not mod_file:
                continue
            try:
                mod_file_abs = os.path.realpath(mod_file)
            except Exception:  # noqa: BLE001
                continue
            if not mod_file_abs.startswith(lib_prefix + os.sep):
                continue
            try:
                importlib.reload(mod)
                reloaded.append(mod_name)
            except Exception as exc:  # noqa: BLE001
                errors[mod_name] = f"{type(exc).__name__}: {exc}"

    send_message(
        "pdv.module.reload_libs.response",
        {"reloaded": reloaded, "errors": errors},
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
    from pdv.comms import get_pdv_tree, send_error, send_message  # noqa: PLC0415
    from pdv.modules import dispatch_handler  # noqa: PLC0415

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
register("pdv.module.create_empty", handle_module_create_empty)
register("pdv.module.update", handle_module_update)
register("pdv.modules.setup", handle_modules_setup)
register("pdv.module.reload_libs", handle_module_reload_libs)
register("pdv.handler.invoke", handle_handler_invoke)
