"""Module discovery and loading utilities."""

from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

from .base import BaseModule
from .manifest import ManifestError, ModuleManifest

MANIFEST_FILENAMES = ("manifest.yaml", "manifest.yml", "manifest.json")


class ModuleLoadError(Exception):
    """Raised when a module fails to load."""


def discover_manifests(modules_dir: Path) -> List[Tuple[Path, ModuleManifest]]:
    """Discover module manifests in a modules directory."""
    modules_dir = modules_dir.expanduser().resolve()
    discovered: List[Tuple[Path, ModuleManifest]] = []
    if not modules_dir.exists():
        return discovered

    for child in modules_dir.iterdir():
        if not child.is_dir():
            continue
        manifest_path = _find_manifest(child)
        if manifest_path:
            manifest = ModuleManifest.load(manifest_path)
            discovered.append((child, manifest))
    return discovered


def _find_manifest(module_dir: Path) -> Path | None:
    for candidate in MANIFEST_FILENAMES:
        path = module_dir / candidate
        if path.exists():
            return path
    return None


def load_module(module_dir: Path, manifest: ModuleManifest) -> BaseModule:
    """Load a module package from disk and return an instance."""
    module_file = module_dir / "module.py"
    if not module_file.exists():
        raise ModuleLoadError(f"Module file not found: {module_file}")

    spec = importlib.util.spec_from_file_location(f"{manifest.name}_module", module_file)
    if spec is None or spec.loader is None:
        raise ModuleLoadError(f"Unable to create spec for module at {module_file}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)  # type: ignore[arg-type]
    except Exception as exc:
        raise ModuleLoadError(f"Failed to import module {manifest.name}") from exc

    module_class = getattr(module, "Module", None)
    if module_class is None or not inspect.isclass(module_class):
        raise ModuleLoadError("Module must define a 'Module' class")
    if not issubclass(module_class, BaseModule):
        raise ModuleLoadError("Module.Module must inherit from BaseModule")

    instance: BaseModule = module_class(manifest)
    return instance


def load_all(modules_dir: Path) -> List[BaseModule]:
    """Discover and load all modules in a directory."""
    modules: List[BaseModule] = []
    for directory, manifest in discover_manifests(modules_dir):
        modules.append(load_module(directory, manifest))
    return modules


__all__ = [
    "ModuleLoadError",
    "discover_manifests",
    "load_module",
    "load_all",
    "ModuleManifest",
    "ManifestError",
]
