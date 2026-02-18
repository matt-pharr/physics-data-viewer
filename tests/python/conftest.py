"""
Pytest configuration for Python backend tests.
"""

import sys
from pathlib import Path

# Add the electron/main/init directory to Python path for imports
init_dir = Path(__file__).parent.parent.parent / 'electron' / 'main' / 'init'
if str(init_dir) not in sys.path:
    sys.path.insert(0, str(init_dir))
