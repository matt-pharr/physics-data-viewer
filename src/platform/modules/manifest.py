"""Module manifest definitions and validation utilities."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

try:
    import yaml
except ImportError:  # pragma: no cover - dependency should be installed via package metadata
    yaml = None  # type: ignore


class ManifestError(Exception):
    """Raised when a manifest file is missing or invalid."""


@dataclass
class ModuleManifest:
    """Represents a module manifest describing module metadata."""

    name: str
    version: str
    author: str
    description: str = ""
    dependencies: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "ModuleManifest":
        """Create a manifest instance from a dictionary with validation."""
        required = ("name", "version", "author")
        missing = [key for key in required if key not in raw or not raw[key]]
        if missing:
            raise ManifestError(f"Missing required manifest fields: {', '.join(missing)}")

        dependencies = raw.get("dependencies", []) or []
        if not isinstance(dependencies, list) or not all(isinstance(dep, str) for dep in dependencies):
            raise ManifestError("dependencies must be a list of strings")
        dependencies = list(dict.fromkeys(dependencies))  # remove duplicates while preserving order

        description = raw.get("description", "") or ""
        if raw.get("name") in dependencies:
            raise ManifestError("Manifest cannot list itself as a dependency")
        return cls(
            name=str(raw["name"]),
            version=str(raw["version"]),
            author=str(raw["author"]),
            description=str(description),
            dependencies=list(dependencies),
        )

    @classmethod
    def load(cls, manifest_path: Path) -> "ModuleManifest":
        """Load a manifest from a YAML or JSON file."""
        if not manifest_path.exists():
            raise ManifestError(f"Manifest file not found: {manifest_path}")

        data: Dict[str, Any]
        if manifest_path.suffix.lower() == ".json":
            data = json.loads(manifest_path.read_text())
        else:
            if yaml is None:
                raise ManifestError("pyyaml is required to read YAML manifest files")
            data = yaml.safe_load(manifest_path.read_text()) or {}
        if not isinstance(data, dict):
            raise ManifestError("Manifest content must be a mapping")
        return cls.from_dict(data)

    def to_dict(self) -> Dict[str, Any]:
        """Return manifest data as a dictionary."""
        return {
            "name": self.name,
            "version": self.version,
            "author": self.author,
            "description": self.description,
            "dependencies": list(self.dependencies),
        }
