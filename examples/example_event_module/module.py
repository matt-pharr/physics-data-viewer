"""Example module demonstrating event communication."""

from __future__ import annotations

from platform.modules.base import BaseModule
from platform.modules.context import ModuleContext


class Module(BaseModule):
    """Broadcasts an event and records any replies."""

    def __init__(self, manifest):
        super().__init__(manifest)
        self.received = []
        self.ctx: ModuleContext | None = None

    def initialize(self, context: ModuleContext | None = None):
        self.ctx = context
        if context:
            context.subscribe_event("example.echo", self._handle_echo)
            context.publish_event("example.echo", {"message": "hello from event module"}, metadata={"role": "example"})
        self.mark_initialized()

    def _handle_echo(self, event):
        self.received.append(event.payload)
        if self.ctx:
            self.ctx.set_project_value(["example_event_module", "last_message"], event.payload.get("message"))
