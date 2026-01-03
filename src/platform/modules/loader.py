"""Module discovery and loading utilities."""

from __future__ import annotations

import importlib.util
import inspect
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple
from importlib.abc import Loader

from .base import BaseModule
from .manifest import ManifestError, ModuleManifest
from .resolver import ResolutionResult, resolve_dependencies

MANIFEST_FILENAMES = ("manifest.yaml", "manifest.yml", "manifest.json")


class ModuleLoadError(Exception):
    """Raised when a module fails to load."""


@dataclass
class ModuleLoadResult:
    """Container for module load outcomes."""

    modules: List[BaseModule] = field(default_factory=list)
    errors: List[Exception] = field(default_factory=list)

    def shutdown_all(self) -> None:
        """Invoke shutdown on loaded modules in reverse order."""
        for module in reversed(self.modules):
            try:
                module.shutdown()
            except Exception as exc:  # pragma: no cover - best effort cleanup
                self.errors.append(exc)


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


def _find_manifest(module_dir: Path) -> Optional[Path]:
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
    loader = spec.loader
    if not isinstance(loader, Loader):
        raise ModuleLoadError(f"Invalid loader for module at {module_file}")
    try:
        loader.exec_module(module)
    except Exception as exc:
        raise ModuleLoadError(f"Failed to import module {manifest.name}") from exc

    module_class = getattr(module, "Module", None)
    if module_class is None or not inspect.isclass(module_class):
        raise ModuleLoadError("Module must define a 'Module' class")
    if not issubclass(module_class, BaseModule):
        raise ModuleLoadError("Module.Module must inherit from BaseModule")

    instance: BaseModule = module_class(manifest)
    return instance


def load_all(modules_dir: Path) -> ModuleLoadResult:
    """Discover, resolve dependencies, and load all modules in a directory.

    Returns a ModuleLoadResult containing successfully loaded modules and any
    errors encountered (resolution or load errors). Broken modules are skipped
    so they do not crash application startup.
    """

    manifests = discover_manifests(modules_dir)
    manifest_map = {}
    path_map = {}
    for directory, manifest in manifests:
        if manifest.name in manifest_map:
            raise ManifestError(f"Duplicate module name detected: {manifest.name}")
        manifest_map[manifest.name] = manifest
        path_map[manifest.name] = directory

    resolution: ResolutionResult = resolve_dependencies(manifest_map)
    result = ModuleLoadResult(errors=list(resolution.errors))

    for module_name in resolution.order:
        manifest = manifest_map[module_name]
        directory = path_map[module_name]
        try:
            instance = load_module(directory, manifest)
            _initialize_module(instance)
            result.modules.append(instance)
        except Exception as exc:  # pragma: no cover - exercised via tests
            result.errors.append(exc)

    return result


def _initialize_module(module: BaseModule) -> None:
    """Initialize a module and ensure it is marked initialized."""
    module.initialize()
    if not module.initialized:
        module.mark_initialized()


__all__ = [
    "ModuleLoadError",
    "ModuleLoadResult",
    "discover_manifests",
    "load_module",
    "load_all",
]
