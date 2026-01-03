# Quick Start Guide - Running the Electron App

This guide shows you how to run the Physics Data Viewer Electron application with the full Python REPL interface.

## What You'll See

The application provides:
- **Python Editor** with Monaco (VS Code editor) and autocomplete
- **Output Display** showing execution results in real-time
- **State Viewer** showing all session variables
- **Command History** with up/down arrow navigation

## Prerequisites

1. Python 3.8+ with pip
2. Node.js 16+ with npm

## Steps

### 1. Install Python Dependencies

From the repository root:

```bash
pip install -e .[test]
```

### 2. Start the Backend Server

Keep this running in a terminal:

```bash
export PYTHONPATH="$(pwd)/src"
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

You should see:
```
INFO:     Started server process
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### 3. Install Electron Dependencies

Open a **new terminal** and run:

```bash
cd electron
npm install
```

This will download ~500MB of dependencies (Electron, React, Monaco Editor, etc). It only needs to be done once.

### 4. Build and Run the Electron App

```bash
npm start
```

This will:
1. Build the React application with webpack
2. Launch the Electron window
3. Connect to the backend at http://localhost:8000

## Using the Application

### Execute Python Code

1. Type Python code in the editor (e.g., `x = 42`)
2. Press **Ctrl+Enter** (Mac: **Cmd+Enter**) to execute
3. See the output in the middle panel
4. See variables appear in the right panel

### Command History

- Press **↑** (up arrow) to navigate to previous commands
- Press **↓** (down arrow) to navigate to next commands
- History persists across sessions

### Autocomplete

Start typing and press **Ctrl+Space** or just type:
- Python keywords: `imp` → suggestions include `import`
- Builtins: `pri` → suggestions include `print`
- Variables: `x` → shows defined variables starting with 'x'
- Modules: `import num` → suggests `numpy`, `numbers`

### Try These Examples

```python
# Basic calculation
x = 42
y = x * 2
print(f"x={x}, y={y}")

# List comprehension
numbers = [i**2 for i in range(10)]
print(numbers)

# Function definition
def greet(name):
    return f"Hello, {name}!"

message = greet("Physicist")
print(message)
```

## Development Mode

For development with DevTools open:

```bash
cd electron
npm run dev
```

For auto-rebuild on file changes:

```bash
# Terminal 1: Webpack watch mode
cd electron
npm run watch

# Terminal 2: Restart Electron when webpack rebuilds
npm run dev
```

## Troubleshooting

### "Failed to connect to backend"

The backend server is not running. Start it:
```bash
export PYTHONPATH="$(pwd)/src"
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

### Window is blank

Check the DevTools console (View → Toggle Developer Tools). Common issues:
- Webpack build failed: Run `npm run build` and check for errors
- Backend not responding: Check backend terminal for errors

### Monaco Editor not loading

Clear and rebuild:
```bash
cd electron
rm -rf dist node_modules
npm install
npm start
```

## Next Steps

- **PR #9**: Will add the data viewer component for exploring nested data structures
- **PR #10**: Will add command log/history display
- **PR #11-13**: Will add module system integration

## Architecture

```
┌──────────────────────────────────────┐
│   Electron Window (1400x900)        │
│  ┌────────────────────────────────┐ │
│  │ Header: Title + Session Info   │ │
│  ├────────────────────────────────┤ │
│  │ ┌──────────────┬──────────────┐│ │
│  │ │              │              ││ │
│  │ │  Python      │  State       ││ │
│  │ │  Editor      │  Viewer      ││ │
│  │ │  (Monaco)    │  (Variables) ││ │
│  │ │              │              ││ │
│  │ ├──────────────┤              ││ │
│  │ │              │              ││ │
│  │ │  Output      │              ││ │
│  │ │  Display     │              ││ │
│  │ │              │              ││ │
│  │ └──────────────┴──────────────┘│ │
│  └────────────────────────────────┘ │
└──────────────────────────────────────┘
         │ HTTP API
         ▼
┌──────────────────────────────────────┐
│   FastAPI Backend (port 8000)       │
│   - /execute - Run Python code      │
│   - /autocomplete - Get suggestions │
│   - /sessions - Manage sessions     │
└──────────────────────────────────────┘
```
