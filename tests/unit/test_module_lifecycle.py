import textwrap
import time

import pytest
import yaml

from platform.modules.loader import ModuleLoadResult, load_all
from platform.modules.resolver import DependencyResolutionError
from platform.modules.watcher import ModuleWatcher


def _write_module(module_dir, manifest_data, body: str = ""):
    module_dir.mkdir(parents=True, exist_ok=True)
    (module_dir / "manifest.yaml").write_text(yaml.safe_dump(manifest_data))
    indented_body = textwrap.indent(body.strip("\n"), " " * 12)
    if indented_body:
        indented_body = f"\n{indented_body}\n"
    module_code = textwrap.dedent(
        f"""
        from platform.modules.base import BaseModule


        class Module(BaseModule):
            def __init__(self, manifest):
                super().__init__(manifest)
                self.initialize_called = False
                self.shutdown_called = False

            def initialize(self):
                self.initialize_called = True
                self.mark_initialized()
{indented_body}
            def shutdown(self):
                self.shutdown_called = True
        """
    )
    (module_dir / "module.py").write_text(module_code)


def test_modules_load_in_dependency_order(modules_dir):
    base_manifest = {"name": "base", "version": "0.1.0", "author": "Tester"}
    dependent_manifest = {
        "name": "dependent",
        "version": "0.1.0",
        "author": "Tester",
        "dependencies": ["base"],
    }

    _write_module(modules_dir / "base", base_manifest)
    _write_module(modules_dir / "dependent", dependent_manifest)

    result: ModuleLoadResult = load_all(modules_dir)
    assert [module.name for module in result.modules] == ["base", "dependent"]
    assert all(module.initialized for module in result.modules)

    result.shutdown_all()
    assert all(getattr(module, "shutdown_called") for module in result.modules)


def test_missing_dependencies_are_reported_and_skipped(modules_dir):
    _write_module(modules_dir / "good", {"name": "good", "version": "1.0", "author": "Tester"})
    _write_module(
        modules_dir / "broken",
        {
            "name": "broken",
            "version": "1.0",
            "author": "Tester",
            "dependencies": ["missing"],
        },
    )

    result = load_all(modules_dir)
    loaded_names = [module.name for module in result.modules]
    assert loaded_names == ["good"]
    assert any(isinstance(err, DependencyResolutionError) for err in result.errors)


def test_broken_module_does_not_block_others(modules_dir):
    _write_module(modules_dir / "good", {"name": "good", "version": "1.0", "author": "Tester"})
    broken_dir = modules_dir / "bad"
    broken_dir.mkdir(parents=True, exist_ok=True)
    (broken_dir / "manifest.yaml").write_text(
        yaml.safe_dump({"name": "bad", "version": "1.0", "author": "Tester"})
    )
    (broken_dir / "module.py").write_text("raise RuntimeError('import failure')")

    result = load_all(modules_dir)
    assert [module.name for module in result.modules] == ["good"]
    assert any("bad" in str(err) or isinstance(err, Exception) for err in result.errors)


def test_hot_reload_detection(modules_dir):
    module_dir = modules_dir / "hot"
    _write_module(module_dir, {"name": "hot", "version": "1.0", "author": "Tester"})

    events = []

    def on_change(path):
        events.append(path)

    watcher = ModuleWatcher(modules_dir, on_change, poll_interval=0.01)
    watcher.prime()

    # Modify module file to trigger reload
    time.sleep(0.01)
    (module_dir / "module.py").write_text("from platform.modules.base import BaseModule\n")
    watcher.poll_once()

    assert module_dir in events
