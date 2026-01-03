"""Frontend scaffolding for the physics data viewer."""

from .app import FrontendApp
from .base_window import BaseWindow
from .client import BackendClient, ExecuteResult
from .window_manager import WindowManager

__all__ = ["FrontendApp", "BackendClient", "ExecuteResult", "BaseWindow", "WindowManager"]
