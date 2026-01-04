"""Central project tree state and helpers."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, MutableMapping
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

ChangeObserver = Callable[[str, Tuple[str, ...], Any], None]
Resolver = Callable[[], Any]


@dataclass
class LazyNode:
    """Represents a lazily-resolved child value."""

    loader: Callable[[], Any]
    preview: str = "<lazy>"
    metadata: Dict[str, Any] = field(default_factory=dict)
    _resolved: bool = field(default=False, init=False, repr=False)
    _value: Any = field(default=None, init=False, repr=False)

    def resolve(self) -> Any:
        """Materialize the lazy value using the loader."""
        if not self._resolved:
            self._value = self.loader()
            self._resolved = True
        return self._value

    def peek(self) -> Any:
        """Return the preview without forcing materialization."""
        return self._value if self._resolved else self.preview

    @property
    def resolved(self) -> bool:
        """True when the loader has been executed."""
        return self._resolved

    @property
    def resolved_value(self) -> Any:
        """Return the resolved value if available without triggering resolution."""
        return self._value if self._resolved else None


class Tree(MutableMapping[str, Any]):
    """Dict-like container with lazy nodes, metadata, and observers."""

    def __init__(
        self,
        initial: Optional[Dict[str, Any]] = None,
        *,
        path: Tuple[str, ...] = (),
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._data: Dict[str, Any] = {}
        self._metadata: Dict[str, Dict[str, Any]] = {}
        self.metadata: Dict[str, Any] = metadata or {}
        self._observers: List[ChangeObserver] = []
        self._path = tuple(path)

        if initial:
            for key, value in initial.items():
                self[key] = value

    def __getitem__(self, key: str) -> Any:
        value = self._data[key]
        if isinstance(value, LazyNode):
            return self._materialize_lazy(key, value)
        return value

    def __setitem__(self, key: str, value: Any) -> None:
        if isinstance(value, Tree):
            self._attach_child_tree(value, key)
        self._data[key] = value
        self._notify("set", key, value)

    def __delitem__(self, key: str) -> None:
        self._data.pop(key, None)
        self._metadata.pop(key, None)
        self._notify("delete", key, None)

    def __iter__(self) -> Iterator[str]:
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def add_observer(self, observer: ChangeObserver) -> None:
        """Register an observer notified on set/resolve/delete."""
        self._observers.append(observer)

    def set_metadata(self, key: str, metadata: Dict[str, Any]) -> None:
        """Attach metadata to a child node."""
        self._metadata[key] = dict(metadata)

    def get_metadata(self, key: str) -> Dict[str, Any]:
        """Return metadata for a child node."""
        return dict(self._metadata.get(key, {}))

    def add_lazy(
        self,
        key: str,
        loader: Callable[[], Any],
        *,
        preview: str = "<lazy>",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Register a lazy child that resolves when accessed."""
        preview_value = preview
        if metadata and preview == "<lazy>":
            preview_value = str(metadata.get("preview", preview))
        lazy_child = LazyNode(loader=loader, preview=preview_value, metadata=dict(metadata or {}))
        self._data[key] = lazy_child
        if metadata:
            self.set_metadata(key, metadata)
        self._notify("set", key, lazy_child)

    def iter_entries(self) -> Iterable[tuple[str, Any, Dict[str, Any], bool, Optional[Resolver]]]:
        """Yield children along with metadata and lazy resolvers."""
        for key, value in self._data.items():
            metadata = self.get_metadata(key)
            if isinstance(value, LazyNode):
                yield key, value.peek(), metadata, True, lambda key=key, lazy=value: self._materialize_lazy(key, lazy)
            else:
                yield key, value, metadata, False, None

    def set_path(self, path: Iterable[str], value: Any) -> None:
        """Set a value within the tree, creating intermediate nodes as needed."""
        parts = list(path)
        if not parts:
            raise ValueError("Path must contain at least one key.")

        cursor: Any = self
        for key in parts[:-1]:
            if isinstance(cursor, Tree):
                try:
                    next_cursor = cursor[key]
                except KeyError:
                    next_cursor = Tree(path=cursor._child_path(key))
                    cursor[key] = next_cursor
                if not isinstance(next_cursor, Tree):
                    raise ValueError("Cannot descend into non-tree segment.")
                cursor = next_cursor
            elif isinstance(cursor, dict):
                cursor = cursor.setdefault(key, {})
            else:
                raise ValueError("Unsupported container in path traversal.")

        if isinstance(cursor, Tree):
            cursor[parts[-1]] = value
        elif isinstance(cursor, dict):
            cursor[parts[-1]] = value
        else:
            raise ValueError("Unsupported container in path traversal.")

    def get_path(self, path: Iterable[str]) -> Any:
        """Retrieve a nested value by path."""
        parts = list(path)
        if not parts:
            raise ValueError("Path must contain at least one key.")

        cursor: Any = self
        for key in parts:
            if isinstance(cursor, Tree):
                cursor = cursor[key]
            elif isinstance(cursor, dict):
                cursor = cursor[key]
            else:
                raise KeyError(f"Cannot descend into non-container at {key}.")
        return cursor

    def reset(self, *, clear_observers: bool = False) -> None:
        """Clear stored data and metadata."""
        self._data.clear()
        self._metadata.clear()
        if clear_observers:
            self._observers.clear()

    def to_dict(self) -> Dict[str, Any]:
        """Return a serializable representation of the tree for API responses."""
        result: Dict[str, Any] = {}
        for key, value, _, is_lazy, resolver in self.iter_entries():
            if is_lazy and resolver:
                try:
                    resolved = resolver()
                except Exception:
                    resolved = "<lazy>"
                result[key] = self._serialize_value(resolved)
            else:
                result[key] = self._serialize_value(value)
        return result

    def _serialize_value(self, value: Any) -> Any:
        if isinstance(value, Tree):
            return value.to_dict()
        if isinstance(value, dict):
            return {k: self._serialize_value(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._serialize_value(v) for v in value]
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return repr(value)

    def _materialize_lazy(self, key: str, lazy: Optional[LazyNode] = None) -> Any:
        target = lazy or self._data.get(key)
        if not isinstance(target, LazyNode):
            return target
        resolved = target.resolve()
        if isinstance(resolved, Tree):
            self._attach_child_tree(resolved, key)
        self._data[key] = resolved
        self._notify("resolve", key, resolved)
        return resolved

    def _attach_child_tree(self, child: Tree, key: str) -> None:
        child._path = self._child_path(key)
        for observer in self._observers:
            if observer not in child._observers:
                child._observers.append(observer)

    def _child_path(self, key: str) -> Tuple[str, ...]:
        return (*self._path, str(key))

    def _notify(self, event: str, key: str, value: Any) -> None:
        path = self._child_path(key)
        for observer in self._observers:
            observer(event, path, value)


class ProjectTree(Tree):
    """Singleton project tree namespace."""

    def __init__(self) -> None:
        super().__init__(path=("project",))


_PROJECT_TREE = ProjectTree()


def get_project_tree() -> ProjectTree:
    """Return the global ProjectTree singleton."""
    return _PROJECT_TREE


__all__ = ["LazyNode", "Tree", "ProjectTree", "get_project_tree"]
