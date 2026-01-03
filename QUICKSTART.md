# Quick Start Guide - Running the Electron App

## Prerequisites Check

✅ Python 3.8+ installed  
✅ Node.js 18+ and npm installed  
✅ Dependencies installed (`pip install -e .[test]`)  
✅ Electron dependencies installed (`cd electron && npm install`)  
✅ Frontend built (`cd electron && npm run build`)  

## Running the Application

### Step 1: Start the Backend Server

In one terminal:

```bash
# From the project root directory
cd /home/runner/work/physics-data-viewer/physics-data-viewer

# Set PYTHONPATH and start the server
PYTHONPATH=src uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

You should see output like:
```
INFO:     Started server process [xxxxx]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### Step 2: Start the Electron App

In another terminal:

```bash
# Navigate to the electron directory
cd /home/runner/work/physics-data-viewer/physics-data-viewer/electron

# Start Electron
npm start
```

This will launch the Electron window with the Physics Data Viewer application.

## What You'll See

The Electron app window will display:

1. **Header**: "Physics Data Viewer" with connection status indicator
2. **Output Panel**: Shows results of executed commands
3. **Command Input Panel**: Monaco Editor for entering Python code

## Using the App

### Execute Python Code

1. Type Python code in the Monaco editor (bottom panel)
2. Press **Ctrl+Enter** to execute
3. View output in the output panel (top)

Example:
```python
x = 42
print(f"The answer is {x}")
```

### Use Autocomplete

1. Start typing: `pri`
2. See suggestions appear automatically: `print`, `property`, etc.
3. Use arrow keys to navigate suggestions
4. Press Enter or Tab to accept

Or manually trigger with **Ctrl+Space**

### Navigate Command History

1. Execute some commands
2. Press **↑** (Up Arrow) to go to previous commands
3. Press **↓** (Down Arrow) to go forward
4. The editor will show previous commands for re-execution or editing

### Multi-line Code

Just type naturally - the Monaco editor supports multi-line Python:

```python
def greet(name):
    return f"Hello, {name}!"

result = greet("Physicist")
print(result)
```

Press **Ctrl+Enter** to execute the entire block.

## Troubleshooting

### "Cannot connect to backend"

**Issue**: The Electron app shows "Disconnected"  
**Solution**: Make sure the backend server is running on http://127.0.0.1:8000

Check with:
```bash
curl http://127.0.0.1:8000
# Should return: {"status":"ok"}
```

### Backend won't start

**Issue**: `ModuleNotFoundError: No module named 'platform.server'`  
**Solution**: Use `PYTHONPATH=src` before the uvicorn command:

```bash
PYTHONPATH=src uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
```

Or install the package:
```bash
pip install -e .
```

### Electron won't start

**Issue**: `Cannot find module` errors  
**Solution**: Reinstall dependencies:

```bash
cd electron
rm -rf node_modules package-lock.json
npm install
```

### Build errors

**Issue**: Webpack compilation errors  
**Solution**: Rebuild the frontend:

```bash
cd electron
npm run build
```

### Port already in use

**Issue**: `Address already in use`  
**Solution**: Either:
1. Stop the existing server
2. Or use a different port:
   ```bash
   PYTHONPATH=src uvicorn platform.server.app:app --host 127.0.0.1 --port 8001
   ```
   Then update the Electron app's backend URL in `electron/src/App.tsx`

## Current Features (PR #7)

✅ Monaco Editor with Python syntax highlighting  
✅ Code execution with Ctrl+Enter  
✅ Intelligent autocomplete (keywords, variables, builtins)  
✅ Command history with ↑/↓ navigation  
✅ Multi-line code support  
✅ Real-time output display  
✅ Modern dark-themed UI  

## Coming in Future PRs

- 📋 **PR #8**: Data structure tree viewer in Electron
- 📋 **PR #9**: Enhanced command output log with search
- 📋 **PR #10+**: Module system, multi-window support, performance optimizations

## Keyboard Shortcuts

- **Ctrl+Enter**: Execute code
- **Ctrl+Space**: Trigger autocomplete
- **↑**: Previous command in history
- **↓**: Next command in history
- **Tab**: Accept autocomplete suggestion
- **Esc**: Close autocomplete menu

## Testing the Backend API Directly

You can also test the backend API without Electron:

```bash
# In another terminal
python examples/command_input_example.py
```

This demonstrates:
- Session creation
- Code execution
- Autocomplete functionality
- Different completion contexts

## Development Mode

For development with auto-rebuild:

Terminal 1 (Backend):
```bash
PYTHONPATH=src uvicorn platform.server.app:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2 (Frontend auto-rebuild):
```bash
cd electron
npm run dev
```

Terminal 3 (Electron):
```bash
cd electron
npm start
```

With this setup:
- Backend auto-reloads on Python file changes
- Frontend auto-rebuilds on TypeScript/React changes
- Refresh Electron window to see changes

## Need Help?

- Check [electron/README.md](electron/README.md) for frontend-specific docs
- Check [docs/API.md](docs/API.md) for backend API documentation
- Check [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the full roadmap
