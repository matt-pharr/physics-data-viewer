"""Frontend scaffolding for the physics data viewer."""

from .app import FrontendApp
from .base_window import BaseWindow
from .client import BackendClient, ExecuteResult, InvokeResult, MethodInfo
from .context_menu import ContextMenu, ContextMenuBuilder, ContextMenuItem
from .data_viewer import DataViewer, TreeNode, TreeView, VirtualScroller, format_value
from .window_manager import WindowManager

__all__ = [
    "FrontendApp",
    "BackendClient",
    "ExecuteResult",
    "InvokeResult",
    "MethodInfo",
    "BaseWindow",
    "WindowManager",
    "ContextMenu",
    "ContextMenuBuilder",
    "ContextMenuItem",
    "DataViewer",
    "TreeNode",
    "TreeView",
    "VirtualScroller",
    "format_value",
]
