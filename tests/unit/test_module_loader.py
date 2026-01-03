import textwrap

import pytest
import yaml

from platform.modules.base import BaseModule
from platform.modules.loader import ModuleLoadError, discover_manifests, load_module
from platform.modules.manifest import ManifestError


def _write_module(module_dir, manifest_data):
    module_dir.mkdir(parents=True, exist_ok=True)
    (module_dir / "manifest.yaml").write_text(yaml.safe_dump(manifest_data))
    module_code = textwrap.dedent(
        """
        from platform.modules.base import BaseModule


        class Module(BaseModule):
            def __init__(self, manifest):
                super().__init__(manifest)
                self.initialize_called = False

            def initialize(self):
                self.initialize_called = True

            def shutdown(self):
                self.initialized = False
        """
    )
    (module_dir / "module.py").write_text(module_code)


def test_discover_and_load_module(modules_dir):
    manifest_data = {
        "name": "sample",
        "version": "0.1.0",
        "author": "Tester",
        "description": "Sample module",
        "dependencies": ["numpy"],
    }
    module_dir = modules_dir / "sample"
    _write_module(module_dir, manifest_data)

    discovered = discover_manifests(modules_dir)
    assert len(discovered) == 1
    found_dir, manifest = discovered[0]
    assert manifest.name == manifest_data["name"]
    assert manifest.version == manifest_data["version"]
    assert manifest.dependencies == manifest_data["dependencies"]

    instance = load_module(found_dir, manifest)
    assert isinstance(instance, BaseModule)
    instance.initialize()
    assert getattr(instance, "initialize_called", False) is True
    assert instance.name == manifest_data["name"]


def test_missing_required_manifest_fields_raise(modules_dir):
    broken_dir = modules_dir / "broken"
    broken_dir.mkdir()
    (broken_dir / "manifest.yaml").write_text(yaml.safe_dump({"name": "broken"}))

    with pytest.raises(ManifestError):
        discover_manifests(modules_dir)


def test_missing_module_file_raises(modules_dir):
    manifest_data = {"name": "invalid", "version": "1.0.0", "author": "Tester"}
    module_dir = modules_dir / "invalid"
    module_dir.mkdir()
    (module_dir / "manifest.yaml").write_text(yaml.safe_dump(manifest_data))

    discovered = discover_manifests(modules_dir)
    with pytest.raises(ModuleLoadError):
        load_module(discovered[0][0], discovered[0][1])
