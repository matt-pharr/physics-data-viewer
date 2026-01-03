from __future__ import annotations

from typing import Any

from platform.gui.data_viewer import DataViewer, TreeNode, TreeView, format_value


class _CustomType:
    def __init__(self, label: str) -> None:
        self.label = label

    def show(self) -> str:
        return f"show:{self.label}"

    def plot(self) -> str:
        return "plot-object"


def _find(tree: TreeView, key: str) -> TreeNode:
    for _, node in tree.iter_visible():
        if node.key == key:
            return node
    raise AssertionError(f"Node {key} not found")


def test_tree_view_lazy_loading_and_paths():
    data = {"alpha": {"beta": [1, 2]}, "gamma": 3}
    tree = TreeView(data)

    alpha = _find(tree, "alpha")
    gamma = _find(tree, "gamma")

    assert alpha.path == ("root", "alpha")
    assert gamma.path == ("root", "gamma")
    assert not alpha.children_loaded

    alpha.expand()
    assert alpha.children_loaded
    beta = next(node for _, node in alpha.iter_visible() if node.key == "beta")
    assert beta.path == ("root", "alpha", "beta")


def test_search_reaches_deep_nodes_and_custom_formatting():
    custom = _CustomType("target")
    data = {"branch": {"leaf": custom, "other": 5}}
    tree = TreeView(data)

    assert tree.search("") == []
    matches = tree.search("target")
    assert len(matches) == 1
    assert matches[0].formatted.is_custom
    assert matches[0].formatted.capabilities["show"]
    assert matches[0].formatted.capabilities["plot"]
    assert "show:target" in matches[0].formatted.preview


def test_data_viewer_virtual_window_matches_full_slice():
    data = list(range(200))
    viewer = DataViewer(data, viewport_size=20, overscan=5)

    all_visible = viewer.tree.flatten_visible()
    window = viewer.visible_window(start_index=50)
    start, end = viewer.scroller.visible_range(total_items=len(all_visible), start_index=50)

    assert window == all_visible[start:end]
    assert len(window) == end - start


def test_filter_and_expand_path_helpers():
    nested: dict[str, Any] = {"outer": {"inner": {"value": 9}}}
    tree = TreeView(nested)

    filtered = tree.filter(lambda node: node.key == "inner")
    assert filtered and filtered[0].path == ("root", "outer", "inner")

    target = tree.expand_path(("root", "outer", "inner", "value"))
    assert target is not None
    assert target.path[-1] == "value"
