"""Module utilities and shared hooks."""

from platform.modules.base import BaseModule
from platform.modules.context import ModuleContext
from platform.modules.event_system import EventSystem, Event
from platform.modules.ui_registry import UIRegistry, UIPanel
from platform.state.project_tree import get_project_tree

__all__ = ["BaseModule", "ModuleContext", "UIRegistry", "UIPanel", "EventSystem", "Event", "get_project_tree"]
