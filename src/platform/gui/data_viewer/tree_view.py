"""High-level tree representation for nested data with lazy loading."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, List, Optional, Sequence, Tuple

from .formatting import FormattedValue, format_value
from .virtual_scroller import VirtualScroller

Formatter = Callable[[Any], FormattedValue]
Path = Tuple[str, ...]


@dataclass
class TreeNode:
    """Node in a nested data tree."""

    key: str
    value: Any
    path: Path
    formatter: Formatter = format_value
    is_leaf: bool = False
    _children_loader: Optional[Callable[[], List["TreeNode"]]] = None
    _children: Optional[List["TreeNode"]] = field(default=None, init=False, repr=False)
    is_expanded: bool = field(default=False, init=False)
    _formatted: Optional[FormattedValue] = field(default=None, init=False, repr=False)

    @property
    def formatted(self) -> FormattedValue:
        """Return cached formatted value for display."""
        if self._formatted is None:
            self._formatted = self.formatter(self.value)
        return self._formatted

    @property
    def has_children(self) -> bool:
        """True if the node can produce children."""
        return self._children_loader is not None

    @property
    def children_loaded(self) -> bool:
        """True when children have been materialized."""
        return self._children is not None

    @property
    def children(self) -> List["TreeNode"]:
        """Return materialized children or an empty list."""
        if self._children is None:
            return []
        return self._children

    def expand(self) -> None:
        """Materialize children if available."""
        if self._children_loader and self._children is None:
            self._children = self._children_loader()
        self.is_expanded = True

    def iter_visible(self, depth: int = 0) -> Iterable[tuple[int, "TreeNode"]]:
        """Yield visible nodes depth-first."""
        yield depth, self
        if not self.is_expanded:
            return
        for child in self.children:
            yield from child.iter_visible(depth + 1)

    def iter_deep(self, depth: int = 0) -> Iterable[tuple[int, "TreeNode"]]:
        """Yield all nodes, expanding as needed."""
        yield depth, self
        if self.has_children and not self.children_loaded:
            self.expand()
        for child in self.children:
            yield from child.iter_deep(depth + 1)

    def find_by_path(self, path: Path) -> Optional["TreeNode"]:
        """Find a descendant by full path."""
        if path == self.path:
            return self
        if not path[: len(self.path)] == self.path:
            return None
        if self.has_children and not self.children_loaded:
            self.expand()
        for child in self.children:
            found = child.find_by_path(path)
            if found:
                return found
        return None


class TreeView:
    """A logical tree representation with search and lazy traversal."""

    def __init__(self, data: Any, formatter: Formatter = format_value, *, preload_root: bool = True) -> None:
        self.formatter = formatter
        self.root = self._build_node("root", data, path=())
        if preload_root:
            self.root.expand()

    def _build_node(self, key: str, value: Any, path: Path) -> TreeNode:
        is_container = isinstance(value, (dict, list, tuple))
        node_path = (*path, str(key))
        loader: Optional[Callable[[], List[TreeNode]]] = None
        if is_container:
            def loader_func(val: Any = value, node_path: Path = node_path) -> List[TreeNode]:
                return self._build_children(val, node_path)

            loader = loader_func
        return TreeNode(
            key=str(key),
            value=value,
            path=node_path,
            formatter=self.formatter,
            is_leaf=not is_container,
            _children_loader=loader,
        )

    def _build_children(self, value: Any, path: Path) -> List[TreeNode]:
        children: List[TreeNode] = []
        if isinstance(value, dict):
            iterator = value.items()
        elif isinstance(value, (list, tuple)):
            iterator = enumerate(value)
        else:  # pragma: no cover - guard for unexpected containers
            return children
        for child_key, child_value in iterator:
            children.append(self._build_node(str(child_key), child_value, path))
        return children

    def iter_visible(self) -> Iterable[tuple[int, TreeNode]]:
        """Iterate over currently expanded nodes."""
        yield from self.root.iter_visible(depth=0)

    def iter_all(self) -> Iterable[tuple[int, TreeNode]]:
        """Iterate over all nodes, expanding lazily."""
        yield from self.root.iter_deep(depth=0)

    def search(self, text: str) -> List[TreeNode]:
        """Return nodes whose key or preview matches the search text."""
        if not text:
            return []
        needle = text.lower()
        matches: List[TreeNode] = []
        for _, node in self.iter_all():
            if needle in node.key.lower() or needle in node.formatted.preview.lower():
                matches.append(node)
        return matches

    def filter(self, predicate: Callable[[TreeNode], bool]) -> List[TreeNode]:
        """Return nodes matching a predicate."""
        return [node for _, node in self.iter_all() if predicate(node)]

    def expand_path(self, path: Sequence[str]) -> Optional[TreeNode]:
        """Expand nodes along the given path and return the targeted node."""
        target_path: Path = tuple(path)
        node = self.root.find_by_path(target_path)
        if node:
            node.expand()
        return node

    def flatten_visible(self) -> List[tuple[int, TreeNode]]:
        """Return a list of visible nodes with depth information."""
        return list(self.iter_visible())


class DataViewer:
    """Combines tree traversal with virtualization for large datasets."""

    def __init__(
        self,
        data: Any,
        formatter: Formatter = format_value,
        *,
        viewport_size: int = 50,
        overscan: int = 10,
    ) -> None:
        self.tree = TreeView(data, formatter=formatter)
        self.scroller = VirtualScroller(viewport_size=viewport_size, overscan=overscan)

    def visible_window(self, start_index: int = 0) -> List[tuple[int, TreeNode]]:
        """Return a virtualized slice of the currently visible nodes."""
        visible = self.tree.flatten_visible()
        start, end = self.scroller.visible_range(total_items=len(visible), start_index=start_index)
        return visible[start:end]

    def search(self, text: str) -> List[TreeNode]:
        """Search across all nodes."""
        return self.tree.search(text)
