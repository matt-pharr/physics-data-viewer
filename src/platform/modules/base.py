"""Base classes for platform modules."""

from __future__ import annotations

import abc
from typing import Optional

from .manifest import ModuleManifest


class BaseModule(abc.ABC):
    """Abstract base class for all platform modules."""

    def __init__(self, manifest: ModuleManifest) -> None:
        self.manifest = manifest
        self.initialized: bool = False

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

    @abc.abstractmethod
    def initialize(self) -> None:
        """Perform module setup. Called after loading."""

    def shutdown(self) -> None:
        """Optional cleanup hook executed during shutdown."""
        return None
