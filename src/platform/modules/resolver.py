"""Dependency resolution utilities for platform modules."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from .manifest import ModuleManifest


class DependencyResolutionError(Exception):
    """Raised when module dependencies cannot be resolved."""

    def __init__(self, message: str, module: str | None = None) -> None:
        super().__init__(message)
        self.module = module


@dataclass
class ResolutionResult:
    """Result of dependency resolution."""

    order: List[str] = field(default_factory=list)
    errors: List[DependencyResolutionError] = field(default_factory=list)

    @property
    def has_errors(self) -> bool:
        return bool(self.errors)


def resolve_dependencies(manifests: Dict[str, ModuleManifest]) -> ResolutionResult:
    """Resolve dependency order while allowing partial success.

    Returns load order for resolvable modules and collects errors for modules
    with missing or cyclic dependencies. Modules that cannot be resolved are
    excluded from the returned order so they can be safely skipped by loaders.
    """

    remaining: Dict[str, ModuleManifest] = dict(manifests)
    loaded = set()
    order: List[str] = []
    errors: List[DependencyResolutionError] = []

    while remaining:
        progress = False
        for name, manifest in list(remaining.items()):
            missing = [dep for dep in manifest.dependencies if dep not in manifests]
            if missing:
                errors.append(
                    DependencyResolutionError(
                        f"Missing dependencies for {name}: {', '.join(sorted(missing))}", name
                    )
                )
                remaining.pop(name)
                progress = True
                continue

            if all(dep in loaded for dep in manifest.dependencies):
                order.append(name)
                loaded.add(name)
                remaining.pop(name)
                progress = True

        if not progress:
            # Cyclic or unresolved dependencies among remaining modules.
            cycle_names = ", ".join(sorted(remaining.keys()))
            errors.append(
                DependencyResolutionError(f"Cyclic or unresolved dependencies: {cycle_names}")
            )
            break

    return ResolutionResult(order=order, errors=errors)


__all__ = ["DependencyResolutionError", "ResolutionResult", "resolve_dependencies"]
