import pytest

from platform.modules.base import BaseModule
from platform.modules.context import ModuleContext
from platform.modules.event_system import EventSystem
from platform.modules.manifest import ModuleManifest
from platform.modules.ui_registry import UIRegistry
from platform.server.state import StateManager
from platform.state.project_tree import ProjectTree


class _DummyModule(BaseModule):
    def initialize(self):
        self.mark_initialized()


def test_publish_subscribe_with_filter():
    bus = EventSystem()
    received = []

    bus.subscribe(
        "update",
        lambda event: received.append((event.payload, event.metadata.get("tag"))),
        predicate=lambda event: event.metadata.get("tag") == "keep",
        module="observer",
    )

    bus.publish("update", {"value": 1}, metadata={"tag": "drop"})
    results = bus.publish("update", {"value": 2}, source="source-module", metadata={"tag": "keep"})

    assert results == [None]
    assert received == [({"value": 2}, "keep")]


def test_dependency_resolution_enforces_manifest():
    bus = EventSystem()
    manifest_a = ModuleManifest(name="alpha", version="0.1.0", author="Tester")
    manifest_b = ModuleManifest(name="beta", version="0.1.0", author="Tester", dependencies=["alpha"])

    module_a = _DummyModule(manifest_a)
    module_b = _DummyModule(manifest_b)

    bus.register_module(module_a, manifest_a)
    bus.register_module(module_b, manifest_b)

    context_b = ModuleContext(
        manifest=manifest_b,
        state_manager=StateManager(),
        project_tree=ProjectTree(),
        ui_registry=UIRegistry(),
        event_system=bus,
    )

    assert context_b.get_dependency("alpha") is module_a
    with pytest.raises(PermissionError):
        context_b.get_dependency("gamma")


def test_state_and_tree_notifications():
    bus = EventSystem()
    tree = ProjectTree()
    state_manager = StateManager()

    bus.attach_project_tree(tree)
    bus.attach_state_manager(state_manager)

    observed = []
    bus.subscribe(
        "project_tree",
        lambda event: observed.append(("tree", event.metadata["action"], event.metadata["path"])),
    )
    bus.subscribe(
        "session_state",
        lambda event: observed.append(("state", event.metadata["action"], event.metadata.get("session"))),
    )

    tree["root"] = {"value": 1}
    session_id = state_manager.create_session("session-one")
    state_manager.set_nested(session_id, ["nested", "value"], 2)

    assert ("tree", "set", ("project", "root")) in observed
    assert ("state", "create", session_id) in observed
    assert ("state", "set", session_id) in observed
