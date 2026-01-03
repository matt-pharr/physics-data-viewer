"""Minimal example module implementation."""

from platform.modules.base import BaseModule
from platform.modules.manifest import ModuleManifest


class Module(BaseModule):
    """Example module that tracks initialization."""

    def __init__(self, manifest: ModuleManifest):
        super().__init__(manifest)
        self.setup_message = ""

    def initialize(self):
        self.setup_message = f"{self.name} initialized"
        self.mark_initialized()

    def shutdown(self):
        self.setup_message = f"{self.name} shut down"
