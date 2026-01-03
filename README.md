# Physics Data Viewer

This repository hosts the foundations of a modern physics data analysis platform. The application is designed for domain experts to explore nested data structures, run Python analysis, and extend functionality through a module (plugin) system.

For the complete vision and roadmap, see [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md). This initial phase delivers:

- Python package scaffolding using a `src/` layout
- A module system foundation with manifest parsing and filesystem discovery
- `ShowablePlottable` protocols for custom data types that can render text (`show`) and visualizations (`plot`)
- Double-click invocation of `show`/`plot` methods with result routing alongside right-click context menus
- Example modules and data types demonstrating expected patterns
- Pytest-based test infrastructure
- Nested data viewer utilities with lazy loading, search, and virtual scrolling for large datasets
- **Python command input with autocomplete (PR #7)**: Monaco Editor-based input with syntax highlighting, command history, and intelligent autocomplete

## Frontend scaffold (PR #3)

The repository now includes a lightweight frontend scaffold that can operate against the FastAPI backend without requiring Node or Electron during development. The `platform.gui.FrontendApp` coordinates a `BackendClient` and a `WindowManager`, allowing multiple logical windows to share or create new backend sessions.

```bash
export PYTHONPATH="$(pwd)/src"  # ensures our package shadows stdlib 'platform'
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

Then, from another shell (with the same PYTHONPATH set) or after `pip install -e .`:

```python
import asyncio
from platform.gui import FrontendApp

async def main():
    app = FrontendApp(backend_url="http://localhost:8000")
    await app.start(dev_mode=True)
    result = await app.send_command("x = 1")
    print(result.stdout)
    await app.shutdown()

asyncio.run(main())
```

This scaffold provides a foundation for future GUI work while keeping connectivity and window lifecycle testable.

## Electron Frontend (PR #7)

The `electron/` directory contains a modern Electron-based frontend with:

- **Monaco Editor**: VS Code's editor component for Python code input
- **Syntax Highlighting**: Built-in Python syntax highlighting
- **Command History**: Navigate previously executed commands with ↑/↓ arrows
- **Autocomplete**: Intelligent completion for keywords, builtins, state variables, and modules
- **Multi-line Support**: Full support for multi-line Python code

See [electron/README.md](electron/README.md) for setup and development instructions.

## Getting Started

1. Install dependencies (including testing extras):

```bash
pip install -e .[test]
```

2. Run the test suite:

```bash
pytest
```

3. Explore the examples:
   - `examples/minimal_module/` shows the simplest module with a manifest and `Module` class.
   - `examples/custom_types_example/` contains reference implementations of `ShowablePlottable` data types.
   - `examples/command_input_example.py` demonstrates the autocomplete and command history features (PR #7).

## Module Manifests

Modules reside in a `modules/` directory. Each module folder requires a manifest file (`manifest.yaml`, `manifest.yml`, or `manifest.json`) containing:

- `name`, `version`, `author` (required)
- `description` (optional)
- `dependencies` list (optional)

The loader in `platform.modules.loader` discovers manifest files and imports the corresponding `Module` class from `module.py`.
