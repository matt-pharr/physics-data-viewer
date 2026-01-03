# Physics Data Viewer - Electron Frontend

This directory contains the Electron-based frontend for the Physics Data Viewer application.

## Features

- **Monaco Editor**: VS Code's editor component for Python code input
- **Syntax Highlighting**: Built-in Python syntax highlighting
- **Command History**: Navigate through previously executed commands using ↑/↓ arrow keys
- **Autocomplete**: Intelligent code completion for:
  - Python keywords
  - Python builtins
  - Session state variables
  - Common module names
- **Multi-line Input**: Support for multi-line Python code
- **Real-time Output**: See execution results immediately
- **State Viewer**: Monitor session variables in real-time
- **Keyboard Shortcuts**:
  - `Ctrl+Enter` (Mac: `Cmd+Enter`): Execute current code
  - `↑`: Navigate to previous command in history
  - `↓`: Navigate to next command in history

## Setup

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Python backend server running (see main README)

### Installation

```bash
cd electron
npm install
```

### Running the Application

**Important**: The backend server must be running first!

#### Step 1: Start the Python backend server

From the project root directory:

```bash
# Set Python path
export PYTHONPATH="$(pwd)/src"

# Start the backend server
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

Keep this terminal open - the server needs to be running.

#### Step 2: Start the Electron app

In a new terminal:

```bash
cd electron

# Build and start the app
npm start

# Or for development with dev tools open
npm run dev
```

The application will:
1. Build the React bundle with webpack
2. Launch the Electron window
3. Connect to the backend at http://localhost:8000
4. Create a new session automatically

### Development Workflow

For active development with auto-rebuild:

```bash
# Terminal 1: Backend server
export PYTHONPATH="$(pwd)/src"
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000

# Terminal 2: Webpack watch mode
cd electron
npm run watch

# Terminal 3: Electron (restart after webpack rebuilds)
cd electron
npm run dev
```

## Architecture

### Components

- **App.tsx**: Main application layout
  - Manages session initialization
  - Coordinates editor, output, and state viewer
  - Handles connection errors

- **PythonEditor** (`src/components/CommandInput/PythonEditor.tsx`): Monaco Editor component
  - Handles user input
  - Manages command history
  - Integrates autocomplete
  - Executes commands on Ctrl+Enter

- **OutputPanel** (`src/components/OutputDisplay/OutputPanel.tsx`): Output display
  - Shows stdout, stderr, and errors
  - Color-coded output
  - Loading indicators

- **StatePanel** (`src/components/StateViewer/StatePanel.tsx`): Variable inspector
  - Displays session variables
  - Filters out Python internals
  - Type-aware formatting

### Hooks

- **useCommandExecution** (`src/hooks/useCommandExecution.ts`): Command execution logic
  - Manages backend communication
  - Tracks execution history
  - Handles errors gracefully

### Utils

- **autocompletion** (`src/utils/autocompletion.ts`): Autocomplete utilities
  - `getCompletions()`: Fetches suggestions from backend
  - `getWordAtPosition()`: Extracts word at cursor
  - `filterCompletions()`: Client-side filtering
  - `getPythonKeywords()`: Local keyword fallback
  - `getPythonBuiltins()`: Local builtins fallback

## Building for Distribution

To create a distributable package:

```bash
npm run build        # Build the React bundle
electron-builder    # Package for current platform
```

This will create platform-specific installers in the `dist/` directory.

## Troubleshooting

### "Failed to connect to backend"

Make sure the Python backend is running:
```bash
export PYTHONPATH="$(pwd)/src"
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

### Monaco Editor not loading

Try rebuilding:
```bash
rm -rf dist node_modules
npm install
npm start
```

### WebSocket/CORS errors

The backend must be running on http://localhost:8000. Check the CSP in index.html if you need to use a different URL.

## Configuration

Edit `src/components/App.tsx` to change the backend URL:

```tsx
const BACKEND_URL = 'http://localhost:8000';  // Change this if needed
```

The editor connects to the backend at `http://localhost:8000` by default. You can configure this via the `backendUrl` prop:

```tsx
<PythonEditor
  sessionId="your-session-id"
  backendUrl="http://your-backend:8000"
  onExecute={(code) => console.log('Executing:', code)}
/>
```

## Testing

Run the test suite:

```bash
npm test
```

## Monaco Editor Configuration

The editor is configured with:
- Dark theme (`vs-dark`)
- Line numbers enabled
- Minimap disabled for better screen real estate
- Word wrap enabled
- Tab size: 4 spaces
- Python language mode with autocomplete

## Autocomplete Integration

Autocomplete suggestions are fetched from the backend `/autocomplete` endpoint, which provides:
- Python keywords
- Python builtins
- Variables from the current session state
- Module names in import contexts

The frontend caches and filters results for responsive typing experience.
