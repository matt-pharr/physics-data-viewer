# Physics Data Viewer - Electron Frontend

This directory contains the Electron-based frontend for the Physics Data Viewer application, implementing PR #7 features: Python Command Input & Autocomplete and PR #8 data viewer integration.

## Features

- **Monaco Editor Integration**: Full-featured code editor with Python syntax highlighting
- **Autocomplete**: Intelligent code completion for:
  - Python keywords (if, for, while, etc.)
  - Namespace variables and functions
  - Builtin Python functions and types
- **Command History**: Navigate through previously executed commands using ↑/↓ arrow keys
- **Multi-line Input**: Support for multi-line Python code
- **Real-time Execution**: Execute code with Ctrl+Enter and see results immediately
- **Modern UI**: Dark theme with responsive layout
- **Data Viewer**: React tree view with virtual scrolling, context menu actions, and double-click method invocation results

## Setup

### Prerequisites

- Node.js 18+ and npm
- Python 3.8+ with the backend installed

### Installation

```bash
cd electron
npm install
```

## Development

### Start the Backend Server

First, start the Python backend server:

```bash
# From the project root
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

### Build the Frontend

Build the Electron frontend:

```bash
cd electron
npm run build
```

### Run the Application

Start the Electron app:

```bash
npm start
```

Or for development with auto-rebuild:

```bash
npm run dev  # In one terminal
npm start    # In another terminal
```

## Project Structure

```
electron/
├── main.js                      # Electron main process
├── preload.js                   # Preload script for context isolation
├── package.json                 # Node.js dependencies
├── webpack.config.js            # Webpack build configuration
├── tsconfig.json                # TypeScript configuration
├── jest.config.js               # Jest test configuration
└── src/
    ├── index.tsx                # React entry point
    ├── index.html               # HTML template
    ├── App.tsx                  # Main application component
    ├── App.css                  # Application styles
    ├── api/
    │   └── client.ts            # Backend HTTP client
    ├── components/
    │   ├── ContextMenu/         # Context menu UI
    │   ├── DataViewer/          # Tree view + virtual scroller
    │   └── ResultDisplay/       # Result history panel
    │   └── CommandInput/
    │       └── PythonEditor.tsx # Monaco-based Python editor
    └── utils/
        ├── dataFormatting.ts    # Data viewer formatting helpers
        └── methodIntrospection.ts # Backend method helpers
        └── commandHistory.ts    # Command history manager
```

## Usage

### Executing Code

1. Type Python code in the Monaco editor
2. Press **Ctrl+Enter** to execute
3. View output in the output panel above

### Autocomplete

- Autocomplete suggestions appear automatically as you type
- Press **Ctrl+Space** to manually trigger autocomplete
- Use arrow keys to navigate suggestions
- Press **Enter** or **Tab** to accept a suggestion

### Command History

- Press **↑** (Up Arrow) to navigate to previous commands
- Press **↓** (Down Arrow) to navigate to next commands
- History is preserved within the current session

### Keyboard Shortcuts

- **Ctrl+Enter**: Execute code
- **Ctrl+Space**: Trigger autocomplete
- **↑/↓**: Navigate command history (when cursor is at top/bottom)
- Standard Monaco editor shortcuts are also available

## Architecture

The frontend communicates with the Python backend via HTTP REST API:

1. **Session Management**: Creates and maintains a session with the backend
2. **Code Execution**: Sends code to backend via `/execute` endpoint
3. **Autocomplete**: Requests completions via `/autocomplete` endpoint
4. **State Management**: Backend maintains namespace state between executions

## Testing

The backend autocomplete logic has comprehensive unit tests:

```bash
# From project root
pytest tests/unit/test_autocomplete.py -v
```

Electron frontend unit and integration tests (Jest + React Testing Library):

```bash
cd electron
npm test
```

## Known Limitations

- Autocomplete does not yet support attribute completion (e.g., `obj.method`)
- No support for multi-file modules yet
- Limited context-aware suggestions

## Future Enhancements (Planned for Later PRs)

- Module/plugin system integration
- Multi-window support
- Performance optimizations for large datasets

## Troubleshooting

### "Cannot connect to backend"

Ensure the backend server is running:
```bash
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

### Build Errors

Clear node_modules and reinstall:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Electron Won't Start

Check that the build was successful:
```bash
npm run build
ls -la dist/  # Should contain bundle.js and index.html
```

## Contributing

This frontend follows the development plan in `DEVELOPMENT_PLAN.md`. Future PRs will add:

- PR #8: REPL environment enhancements
- PR #9: Command output log display
- PR #10+: Module system, multi-window support, and more

See `DEVELOPMENT_PLAN.md` for the complete roadmap.
