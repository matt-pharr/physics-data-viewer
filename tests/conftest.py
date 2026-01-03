import importlib.util
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
PLATFORM_PKG = SRC / "platform"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# Ensure the local platform package is used instead of the stdlib module.
if "platform" in sys.modules:
    sys.modules.pop("platform")

spec = importlib.util.spec_from_file_location(
    "platform",
    PLATFORM_PKG / "__init__.py",
    submodule_search_locations=[str(PLATFORM_PKG)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["platform"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


@pytest.fixture
def modules_dir(tmp_path: Path) -> Path:
    """Provide a temporary modules directory for tests."""
    path = tmp_path / "modules"
    path.mkdir(parents=True, exist_ok=True)
    return path
