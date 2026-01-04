import textwrap

import pytest
import yaml

from platform.modules.context import ModuleContext
from platform.modules.loader import load_all
from platform.modules.ui_registry import UIRegistry
from platform.server.executor import SubprocessExecutor
from platform.server.state import StateManager
from platform.state.project_tree import Tree, get_project_tree


@pytest.fixture(autouse=True)
def reset_project_tree():
    tree = get_project_tree()
    tree.reset(clear_observers=True)
    yield
    tree.reset(clear_observers=True)


def _write_ui_module(module_dir, manifest_data):
    module_dir.mkdir(parents=True, exist_ok=True)
    (module_dir / "manifest.yaml").write_text(yaml.safe_dump(manifest_data))
    module_code = textwrap.dedent(
        """
        from platform.modules.base import BaseModule
        from platform.modules.context import ModuleContext


        class Module(BaseModule):
            def __init__(self, manifest):
                super().__init__(manifest)
                self.render_count = 0
                self.ctx = None

            def initialize(self, context: ModuleContext | None = None):
                self.ctx = context
                if context:
                    context.expose_lazy_data(["ui_module", "lazy"], loader=lambda: {"rows": [1, 2, 3]}, preview="rows")
                    context.register_panel(
                        title="UI Panel",
                        description="module panel",
                        render=self.render_panel,
                        panel_id="ui-module:panel",
                    )
                self.mark_initialized()

            def render_panel(self):
                self.render_count += 1
                return {"sections": [{"title": "Counts", "items": [{"label": "renders", "value": str(self.render_count)}]}]}
        """
    )
    (module_dir / "module.py").write_text(module_code)


def _build_context_factory(ui_registry: UIRegistry):
    project_tree = get_project_tree()
    state_manager = StateManager()
    executor = SubprocessExecutor(state_manager)

    def factory(manifest):
        return ModuleContext(
            manifest=manifest,
            state_manager=state_manager,
            project_tree=project_tree,
            ui_registry=ui_registry,
            executor=executor,
        )

    return factory


def test_module_registers_panel_and_lazy_data(modules_dir):
    ui_registry = UIRegistry()
    _write_ui_module(modules_dir / "ui_module", {"name": "ui_module", "version": "1.0", "author": "Tester"})
    result = load_all(modules_dir, context_factory=_build_context_factory(ui_registry))

    assert [module.name for module in result.modules] == ["ui_module"]
    panels = ui_registry.list_panels()
    assert len(panels) == 1
    assert panels[0].title == "UI Panel"
    assert "sections" in panels[0].content

    tree = get_project_tree()
    branch = tree.get_path(["ui_module"])
    assert isinstance(branch, Tree)
    assert branch["lazy"]["rows"][0] == 1
    result.shutdown_all()


def test_panel_refresh_and_cleanup(modules_dir):
    ui_registry = UIRegistry()
    _write_ui_module(modules_dir / "ui_module", {"name": "ui_module", "version": "1.0", "author": "Tester"})
    result = load_all(modules_dir, context_factory=_build_context_factory(ui_registry))

    first = ui_registry.refresh_panel("ui-module:panel")
    second = ui_registry.refresh_panel("ui-module:panel")
    first_value = int(first.content["sections"][0]["items"][0]["value"])
    second_value = int(second.content["sections"][0]["items"][0]["value"])
    assert second_value == first_value + 1

    result.shutdown_all()
    assert ui_registry.list_panels() == []
