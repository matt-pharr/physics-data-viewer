"""Serialization helpers for persisting the ProjectTree to a single archive."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any, BinaryIO, Callable, Dict, Union

from .project_tree import LazyNode, ProjectTree, Tree, get_project_tree

ARCHIVE_PAYLOAD = "project.json"
KIND_KEY = "__pdv_kind__"
ArchiveSource = Union[str, Path, bytes, BinaryIO]


class ProjectIOError(Exception):
    """Raised when project save/load operations fail."""


def serialize_project_tree(tree: ProjectTree | Tree) -> bytes:
    """Serialize a ProjectTree into a compressed archive."""
    payload = _serialize_tree(tree)
    buffer = io.BytesIO()
    try:
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(ARCHIVE_PAYLOAD, json.dumps(payload))
    except Exception as exc:  # pragma: no cover - defensive
        raise ProjectIOError("Unable to serialize project tree") from exc
    buffer.seek(0)
    return buffer.getvalue()


def save_project_tree(tree: ProjectTree | Tree, destination: Union[str, Path]) -> Path:
    """Serialize the ProjectTree and write it to disk."""
    target_path = Path(destination)
    target_path.write_bytes(serialize_project_tree(tree))
    return target_path


def load_project_tree(source: ArchiveSource, *, target: ProjectTree | Tree | None = None) -> ProjectTree | Tree:
    """Load a ProjectTree archive into the provided tree (or the global singleton)."""
    data = _read_bytes(source)
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            try:
                payload_raw = archive.read(ARCHIVE_PAYLOAD)
            except KeyError as exc:
                raise ProjectIOError("Archive missing project payload") from exc
    except zipfile.BadZipFile as exc:
        raise ProjectIOError("Provided archive is not a valid project file") from exc

    try:
        payload: Dict[str, Any] = json.loads(payload_raw.decode("utf-8"))
    except Exception as exc:  # pragma: no cover - defensive
        raise ProjectIOError("Unable to decode project payload") from exc

    tree = target or get_project_tree()
    tree.reset(clear_observers=False)
    _apply_tree_payload(tree, payload)
    return tree


def _read_bytes(source: ArchiveSource) -> bytes:
    if isinstance(source, (str, Path)):
        return Path(source).read_bytes()
    if isinstance(source, bytes):
        return source
    if hasattr(source, "read"):
        return source.read()
    raise ProjectIOError("Unsupported archive source provided")


def _serialize_tree(tree: Tree) -> Dict[str, Any]:
    children: Dict[str, Any] = {}
    for key, value in tree._data.items():  # noqa: SLF001 - intentional internal access
        children[str(key)] = _serialize_entry(value, tree.get_metadata(str(key)))
    return {"node_type": "tree", "metadata": dict(tree.metadata), "children": children}


def _serialize_entry(value: Any, metadata: Dict[str, Any]) -> Dict[str, Any]:
    if isinstance(value, Tree):
        return {
            "node_type": "tree",
            "metadata": metadata,
            "value": _serialize_tree(value),
        }
    if isinstance(value, LazyNode):
        if value.resolved and value.resolved_value is not None:
            snapshot = _serialize_value(value.resolved_value)
        else:
            snapshot = _safe_serialize_value(value.loader)
        return {
            "node_type": "lazy",
            "metadata": metadata,
            "preview": value.preview,
            "resolved": value.resolved,
            "snapshot": snapshot,
        }
    return {"node_type": "value", "metadata": metadata, "value": _serialize_value(value)}


def _safe_serialize_value(loader: Callable[[], Any]) -> Any:
    try:
        return _serialize_value(loader())
    except Exception:
        return None


def _serialize_value(value: Any) -> Any:
    if isinstance(value, Tree):
        return _serialize_tree(value)
    if isinstance(value, dict):
        return {KIND_KEY: "dict", "items": {k: _serialize_value(v) for k, v in value.items()}}
    if isinstance(value, (list, tuple)):
        return {KIND_KEY: "list", "items": [_serialize_value(v) for v in value]}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)


def _apply_tree_payload(tree: Tree, payload: Dict[str, Any]) -> None:
    if payload.get("node_type") != "tree":
        raise ProjectIOError("Invalid project payload")
    tree.metadata = dict(payload.get("metadata") or {})
    children = payload.get("children", {})
    if not isinstance(children, dict):
        raise ProjectIOError("Malformed children section in project payload")
    for key, entry in children.items():
        _apply_entry(tree, key, entry)


def _apply_entry(tree: Tree, key: str, entry: Dict[str, Any]) -> None:
    if not isinstance(entry, dict) or "node_type" not in entry:
        raise ProjectIOError(f"Invalid entry for key '{key}'")

    node_type = entry["node_type"]
    metadata = dict(entry.get("metadata") or {})

    if node_type == "tree":
        child_tree = _deserialize_tree(entry.get("value"))
        tree[key] = child_tree
    elif node_type == "lazy":
        preview = entry.get("preview", "<lazy>")
        snapshot = entry.get("snapshot")
        loader = _build_lazy_loader(snapshot)
        tree.add_lazy(key, loader, preview=preview, metadata=metadata or None)
        if entry.get("resolved") and snapshot is not None:
            # Trigger resolution so restored tree reflects resolved state
            _ = tree[key]
    elif node_type == "value":
        tree[key] = _deserialize_value(entry.get("value"))
    else:
        raise ProjectIOError(f"Unknown node type '{node_type}' for key '{key}'")

    if metadata:
        tree.set_metadata(key, metadata)


def _deserialize_tree(serialized: Any) -> Tree:
    if not isinstance(serialized, dict) or serialized.get("node_type") != "tree":
        raise ProjectIOError("Invalid tree payload in archive")
    tree = Tree(metadata=serialized.get("metadata"))
    for key, entry in (serialized.get("children") or {}).items():
        _apply_entry(tree, key, entry)
    return tree


def _deserialize_value(value: Any) -> Any:
    if isinstance(value, dict) and value.get(KIND_KEY):
        kind = value[KIND_KEY]
        if kind == "dict":
            return {k: _deserialize_value(v) for k, v in (value.get("items") or {}).items()}
        if kind == "list":
            return [_deserialize_value(v) for v in (value.get("items") or [])]
    if isinstance(value, dict) and value.get("node_type") == "tree":
        return _deserialize_tree(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return value


def _build_lazy_loader(snapshot: Any) -> Callable[[], Any]:
    if snapshot is None:
        def _raise_missing() -> Any:
            raise ProjectIOError("Lazy node payload missing from archive")

        return _raise_missing

    value = _deserialize_value(snapshot)

    def _loader(value=value) -> Any:
        return value

    return _loader


__all__ = [
    "ProjectIOError",
    "serialize_project_tree",
    "save_project_tree",
    "load_project_tree",
]
