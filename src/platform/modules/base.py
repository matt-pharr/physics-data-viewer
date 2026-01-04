"""Base classes for platform modules."""

from __future__ import annotations

import abc
from typing import Optional, TYPE_CHECKING

from .manifest import ModuleManifest

if TYPE_CHECKING:
    from .context import ModuleContext


class BaseModule(abc.ABC):
    """Abstract base class for all platform modules."""

    def __init__(self, manifest: ModuleManifest) -> None:
        self.manifest = manifest
        self.initialized: bool = False
        self.context: Optional["ModuleContext"] = None

    @property
    def name(self) -> str:
        """Return the module name from its manifest."""
        return self.manifest.name

    @property
    def version(self) -> str:
        """Return the module version from its manifest."""
        return self.manifest.version

    @property
    def author(self) -> str:
        """Return the module author from its manifest."""
        return self.manifest.author

    def mark_initialized(self) -> None:
        """Mark the module as initialized."""
        self.initialized = True

    def attach_context(self, context: "ModuleContext") -> None:
        """Attach a runtime context for interacting with the host application."""
        self.context = context

    @abc.abstractmethod
    def initialize(self) -> None:
        """Perform module setup. Called after loading."""

    def shutdown(self) -> None:
        """Optional cleanup hook executed during shutdown."""
        return None
