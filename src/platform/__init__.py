"""Package initializer ensuring compatibility with stdlib `platform` usage."""

from __future__ import annotations

import importlib.util
import sys
import sysconfig
from pathlib import Path


def _load_stdlib_platform():
    """Load the stdlib platform module under a private name."""
    stdlib_path = Path(sysconfig.get_paths()["stdlib"]) / "platform.py"
    spec = importlib.util.spec_from_file_location("_stdlib_platform", stdlib_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_stdlib_platform = _load_stdlib_platform()
if _stdlib_platform:
    for name in dir(_stdlib_platform):
        if name.startswith("_"):
            continue
        if not hasattr(sys.modules[__name__], name):
            setattr(sys.modules[__name__], name, getattr(_stdlib_platform, name))
