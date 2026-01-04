import textwrap

import pytest
import yaml

from platform.modules.context import ModuleContext
from platform.modules.event_system import EventSystem
from platform.modules.loader import load_all
from platform.modules.ui_registry import UIRegistry
from platform.server.state import StateManager
from platform.state.project_tree import get_project_tree


@pytest.fixture(autouse=True)
def reset_project_tree():
    tree = get_project_tree()
    tree.reset(clear_observers=True)
    yield
    tree.reset(clear_observers=True)


def _write_module(directory, manifest_data, init_body: str, extra_body: str = "") -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "manifest.yaml").write_text(yaml.safe_dump(manifest_data))
    init_block = textwrap.indent(textwrap.dedent(init_body).strip(), " " * 8)
    extra_clean = textwrap.dedent(extra_body).strip()
    extra_block = textwrap.indent(extra_clean, " " * 4) if extra_clean else ""
    module_code = textwrap.dedent(
        f"""
from __future__ import annotations
from platform.modules.base import BaseModule
from platform.modules.context import ModuleContext


class Module(BaseModule):
    def __init__(self, manifest):
        super().__init__(manifest)
        self.ctx = None
        self.received = None

    def initialize(self, context: ModuleContext | None = None):
        self.ctx = context
{init_block}
        self.mark_initialized()

{extra_block}
"""
    )
    (directory / "module.py").write_text(module_code)


def _build_context_factory(event_system: EventSystem):
    project_tree = get_project_tree()
    state_manager = StateManager()
    ui_registry = UIRegistry()

    def factory(manifest):
        return ModuleContext(
            manifest=manifest,
            state_manager=state_manager,
            project_tree=project_tree,
            ui_registry=ui_registry,
            event_system=event_system,
        )

    return factory


def test_modules_communicate_via_events(modules_dir):
    event_system = EventSystem()

    producer_init = """
if context:
    context.subscribe_event("request.data", self._handle_request)
"""
    producer_methods = """
    def _handle_request(self, event):
        if self.ctx:
            self.ctx.publish_event("data.ready", {"value": 42})
"""

    consumer_init = """
if context:
    context.get_dependency("producer")
    context.subscribe_event(
        "data.ready",
        self._handle_data_ready,
        predicate=lambda event: event.source == "producer",
    )
    context.publish_event("request.data", {"purpose": "integration-test"})
"""
    consumer_methods = """
    def _handle_data_ready(self, event):
        if self.ctx:
            self.ctx.set_project_value(["events", "result"], event.payload["value"])
            self.received = event.payload["value"]
"""

    _write_module(
        modules_dir / "producer",
        {"name": "producer", "version": "1.0.0", "author": "Tester"},
        producer_init,
        producer_methods,
    )
    _write_module(
        modules_dir / "consumer",
        {
            "name": "consumer",
            "version": "1.0.0",
            "author": "Tester",
            "dependencies": ["producer"],
        },
        consumer_init,
        consumer_methods,
    )

    result = load_all(modules_dir, context_factory=_build_context_factory(event_system), event_system=event_system)

    tree = get_project_tree()
    assert tree.get_path(["events", "result"]) == 42

    consumer = next(mod for mod in result.modules if mod.name == "consumer")
    producer = next(mod for mod in result.modules if mod.name == "producer")
    assert getattr(consumer, "received") == 42
    assert getattr(producer, "initialized") is True
