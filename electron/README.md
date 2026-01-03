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

### Development

1. Start the Python backend server:
```bash
# From the project root
export PYTHONPATH="$(pwd)/src"
uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

2. Start the Electron app:
```bash
cd electron
npm start
```

### Building

To create a distributable package:

```bash
npm run build
```

This will create platform-specific installers in the `dist/` directory.

## Architecture

### Components

- **PythonEditor** (`src/components/CommandInput/PythonEditor.tsx`): Main editor component using Monaco Editor
  - Handles user input
  - Manages command history
  - Integrates autocomplete
  - Executes commands on Ctrl+Enter

### Utils

- **autocompletion** (`src/utils/autocompletion.ts`): Autocomplete utilities
  - `getCompletions()`: Fetches suggestions from backend
  - `getWordAtPosition()`: Extracts word at cursor
  - `filterCompletions()`: Client-side filtering
  - `getPythonKeywords()`: Local keyword fallback
  - `getPythonBuiltins()`: Local builtins fallback

## Configuration

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
