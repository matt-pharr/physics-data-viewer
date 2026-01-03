# Physics Data Viewer

This repository hosts a modern physics data analysis platform. The application is designed for domain experts to explore nested data structures, run Python analysis, and extend functionality through a module (plugin) system.

For the complete vision and roadmap, see [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Current Status (PR #7)

**PR #7** introduces the **Electron-based frontend** with Python command input and autocomplete:

- ✅ Complete Electron application infrastructure
- ✅ Monaco Editor for Python code editing
- ✅ Intelligent autocomplete (keywords, namespace variables, builtins)
- ✅ Command history with arrow key navigation
- ✅ Multi-line code support
- ✅ Real-time code execution with output display
- ✅ Modern dark-themed UI

### ✅ The Electron App is Ready to Run!

**Quick Start:**

```bash
# Terminal 1: Start the backend
PYTHONPATH=src uvicorn platform.server.app:app --host 127.0.0.1 --port 8000

# Terminal 2: Start Electron (first run npm install in electron directory)
cd electron
npm install  # First time only
npm start    # Builds and launches automatically
```

**Note:** The first `npm start` will build the frontend (10-30 seconds). Subsequent starts are faster.

**See [QUICKSTART.md](QUICKSTART.md) for detailed instructions and troubleshooting.**

### Architecture

```
┌─────────────────────────────────────┐
│   Electron Frontend (React)         │
│   - Monaco Editor (Command Input)   │
│   - Autocomplete Integration        │
│   - Output Display                  │
│   - Modern UI                       │
└──────────────┬──────────────────────┘
               │ HTTP/REST API
┌──────────────▼──────────────────────┐
│   Python Backend (FastAPI)          │
│   - Command Execution               │
│   - Autocomplete Engine             │
│   - State Management                │
│   - Method Introspection            │
└─────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- Python 3.8+
- Node.js 18+ and npm (for Electron frontend)

### Backend Setup

1. Install Python dependencies:

```bash
pip install -e .[test]
```

2. Start the backend server:

```bash
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

### Electron Frontend Setup

1. Install Node.js dependencies:

```bash
cd electron
npm install
```

2. Build the frontend:

```bash
npm run build
```

3. Start the Electron app:

```bash
npm start
```

You should see the Physics Data Viewer window with:
- An output panel showing command results
- A Monaco-based Python editor for entering code
- Real-time syntax highlighting
- Autocomplete suggestions as you type
- Command history navigation with ↑/↓

### Using the Application

1. **Writing Code**: Type Python code in the Monaco editor
2. **Autocomplete**: Press `Ctrl+Space` or just start typing to see suggestions
3. **Execute**: Press `Ctrl+Enter` to execute your code
4. **History**: Use `↑` and `↓` arrow keys to navigate through command history
5. **Multi-line**: Write multi-line Python code naturally

Example commands to try:
```python
# Simple variable
x = 42

# See autocomplete for 'x'
print(x)

# Multi-line function
def greet(name):
    return f"Hello, {name}!"

greet("Physicist")
```

## Running Tests

Run the complete test suite:

```bash
pytest
```

Run specific test modules:

```bash
# Backend autocomplete tests
pytest tests/unit/test_autocomplete.py -v

# All backend tests
pytest tests/unit/ -v

# Integration tests
pytest tests/integration/ -v
```

## Examples

### Backend API Example

```bash
python examples/command_input_example.py
```

This demonstrates:
- Creating a session
- Executing code
- Getting autocomplete suggestions
- Different autocomplete contexts

## Previous Deliverables

This initial phase also delivered:

- Python package scaffolding using a `src/` layout
- A module system foundation with manifest parsing and filesystem discovery
- `ShowablePlottable` protocols for custom data types that can render text (`show`) and visualizations (`plot`)
- Double-click invocation of `show`/`plot` methods with result routing alongside right-click context menus
- Example modules and data types demonstrating expected patterns
- Pytest-based test infrastructure
- Nested data viewer utilities with lazy loading, search, and virtual scrolling for large datasets

## Python GUI Components (Interim)

## Python GUI Components (Interim)

The repository includes a lightweight Python-based frontend scaffold in `src/platform/gui/` that was developed before the Electron infrastructure. These components are functional but will be superseded by Electron/React equivalents in future PRs:

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

## Module Manifests

Modules reside in a `modules/` directory. Each module folder requires a manifest file (`manifest.yaml`, `manifest.yml`, or `manifest.json`) containing:

- `name`, `version`, `author` (required)
- `description` (optional)
- `dependencies` list (optional)

The loader in `platform.modules.loader` discovers manifest files and imports the corresponding `Module` class from `module.py`.

## Documentation

- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) - Complete roadmap and PR breakdown
- [docs/API.md](docs/API.md) - Backend REST API documentation
- [electron/README.md](electron/README.md) - Electron frontend documentation

## Project Structure

```
physics-data-viewer/
├── src/platform/           # Python backend
│   ├── server/            # FastAPI server, execution, autocomplete
│   ├── modules/           # Module loading system
│   ├── types/             # ShowablePlottable protocols
│   ├── utils/             # Utilities
│   └── gui/               # Python GUI components (interim)
├── electron/              # Electron frontend (NEW in PR #7)
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── api/           # Backend client
│   │   └── utils/         # Frontend utilities
│   ├── main.js            # Electron main process
│   └── package.json       # Node.js dependencies
├── tests/                 # Test suite
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── performance/       # Performance tests
├── examples/              # Usage examples
├── docs/                  # Documentation
└── benchmarks/            # Performance benchmarks
```

## Contributing

See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the complete development roadmap. Each PR implements a specific section of the plan.

Current PR: **#7 - Python Command Input & Autocomplete + Electron Infrastructure**

Next PRs:
- **#8**: Electron Data Viewer Integration (port PRs #4-6 to Electron)
- **#9**: Command Output Log Display
- **#10+**: Module system enhancements, performance optimization, packaging

## License

MIT
