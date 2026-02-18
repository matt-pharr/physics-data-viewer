"""
Pytest configuration for Python backend tests.

This configuration ensures that the Python initialization code
from electron/main/init is available for import during tests.
"""

import sys
from pathlib import Path

# Expected directory structure:
# tests/python/conftest.py (this file)
# electron/main/init/python-init.py (the file we need to import)
#
# Path construction: go up 2 levels from this file, then into electron/main/init
init_dir = Path(__file__).parent.parent.parent / 'electron' / 'main' / 'init'

if not init_dir.exists():
    raise RuntimeError(
        f"Could not find init directory at {init_dir}. "
        f"Expected structure: repository_root/electron/main/init/"
    )

if str(init_dir) not in sys.path:
    sys.path.insert(0, str(init_dir))
