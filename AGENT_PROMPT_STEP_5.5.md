# Agent Task: Step 5.5 - Real Kernel Integration + Environment Selector

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.   Step 5 implemented the Tree component with lazy loading.   The app now has a working UI (Console, CommandBox with Monaco, Tree), but the KernelManager is still **stubbed**—it simulates execution instead of running real Python/Julia code.

**Your task is to replace the stub KernelManager with real Jupyter kernel integration using `@jupyterlab/services`, and add a GUI for users to select their Python/Julia runtime environment.**

**Reference files you should read first:**
- `PLAN.md` — Overall architecture and kernel requirements
- `electron/main/kernel-manager.ts` — Current stub implementation
- `electron/main/ipc. ts` — Type definitions for kernel operations
- `electron/main/init/python-init.py` — Init cell for Python
- `electron/main/init/julia-init.jl` — Init cell for Julia

**Current state:**
- Stub KernelManager simulates execution with pattern matching
- Console and CommandBox are functional but connected to stub
- No way for users to configure Python/Julia executable paths

**After this step:**
- Real Jupyter kernels (ipykernel, IJulia) launched and managed
- Code execution returns actual results from Python/Julia interpreters
- Environment selector dialog lets users specify executable paths
- Config persists executable paths for future sessions
- Init cells run on kernel startup with real interpreters

---

## Your Task

### Part 1: Install Dependencies

**Add to `electron/package.json` dependencies:**
```json
{
  "dependencies": {
    "@jupyterlab/services": "^7.0.0",
    "ws": "^8.14.0"
  }
}
```

Run `npm install` after modifying package.json.

---

### Part 2: Real Kernel Manager Implementation

**Location:** `electron/main/kernel-manager.ts`

**Replace the entire file with real Jupyter integration.**

**Key requirements:**

1. **Kernel Lifecycle:**
   - Use `@jupyterlab/services` to start kernels via `KernelManager. startNew()`
   - Support both `ipykernel` (Python) and `IJulia` (Julia)
   - Launch kernels with custom executable paths from config
   - Inject init cells after kernel starts
   - Track kernel status (idle/busy/starting/error/dead)

2. **Execution:**
   - Use `kernel.requestExecute()` to run code
   - Listen to IOPub messages for stdout/stderr/results/errors
   - Collect display_data for images (capture mode)
   - Handle execution_count
   - Set timeout for long-running code (configurable)

3. **Completions & Inspection:**
   - Use `kernel.requestComplete()` for completions
   - Use `kernel.requestInspect()` for inspection

4. **Error Handling:**
   - Detect kernel crashes and update status
   - Retry kernel start on failure (configurable)
   - Log errors clearly for debugging

**Implementation structure (pseudocode):**

```typescript
import { KernelManager as JupyterKernelManager, Kernel } from '@jupyterlab/services';
import { KernelSpec, KernelInfo, KernelExecuteRequest, KernelExecuteResult } from './ipc';

interface ManagedKernel {
  info: KernelInfo;
  kernel: Kernel. IKernelConnection;
  spec: KernelSpec;
  startedAt: number;
  lastActivity: number;
  executionCount: number;
}

export class KernelManager {
  private kernels: Map<string, ManagedKernel> = new Map();
  private jupyterManager: JupyterKernelManager;
  
  constructor() {
    // Initialize Jupyter kernel manager
    // For local kernels, use default server settings
    this.jupyterManager = new JupyterKernelManager();
  }
  
  async start(spec?:  Partial<KernelSpec>): Promise<KernelInfo> {
    const language = spec?.language || 'python';
    const executablePath = spec?.argv? .[0];  // From config
    
    // Determine kernel name
    const kernelName = language === 'python' ? 'python3' :  'julia-1.x';
    
    // Start kernel with custom executable if provided
    const kernel = await this.jupyterManager.startNew({
      name: kernelName,
      // If executablePath provided, pass as environment variable
      // Jupyter will use it to spawn the kernel
    });
    
    const id = kernel.id;
    const kernelInfo:  KernelInfo = {
      id,
      name: kernelName,
      language,
      status: 'starting',
    };
    
    this.kernels.set(id, {
      info: kernelInfo,
      kernel,
      spec: { ...  },
      startedAt: Date.now(),
      lastActivity: Date. now(),
      executionCount:  0,
    });
    
    // Wait for kernel to be ready
    await kernel.ready;
    
    // Run init cell
    const initCode = loadInitCell(language);
    await this.executeInternal(id, initCode, { silent: true });
    
    kernelInfo.status = 'idle';
    return kernelInfo;
  }
  
  async execute(id: string, request:  KernelExecuteRequest): Promise<KernelExecuteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { error: `Kernel not found: ${id}`, duration: 0 };
    }
    
    const startTime = Date.now();
    managed.info.status = 'busy';
    
    const result:  KernelExecuteResult = {
      stdout: '',
      stderr: '',
      result: undefined,
      images: [],
      error: undefined,
    };
    
    try {
      const future = managed.kernel.requestExecute({ code: request.code });
      
      // Listen to IOPub messages
      future.onIOPub = (msg) => {
        const msgType = msg.header.msg_type;
        
        if (msgType === 'stream') {
          const content = msg.content as any;
          if (content.name === 'stdout') {
            result.stdout += content.text;
          } else if (content.name === 'stderr') {
            result.stderr += content.text;
          }
        } else if (msgType === 'execute_result') {
          const content = msg.content as any;
          result.result = content. data['text/plain'];
        } else if (msgType === 'display_data') {
          const content = msg.content as any;
          // Handle images for capture mode
          if (request.capture && content.data['image/png']) {
            result. images?. push({
              mime: 'image/png',
              data: content.data['image/png'],
            });
          }
        } else if (msgType === 'error') {
          const content = msg.content as any;
          result.error = `${content. ename}: ${content.evalue}`;
        }
      };
      
      // Wait for execution to complete
      await future. done;
      
      managed.executionCount++;
      
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      managed.info.status = 'idle';
      managed.lastActivity = Date.now();
      result.duration = Date.now() - startTime;
    }
    
    return result;
  }
  
  async stop(id: string): Promise<boolean> {
    const managed = this.kernels.get(id);
    if (!managed) return false;
    
    await managed.kernel.shutdown();
    this.kernels.delete(id);
    return true;
  }
  
  async restart(id: string): Promise<KernelInfo> {
    const managed = this.kernels.get(id);
    if (!managed) throw new Error(`Kernel not found: ${id}`);
    
    managed.info.status = 'starting';
    await managed.kernel.restart();
    
    // Re-run init cell
    const initCode = loadInitCell(managed.spec.language);
    await this.executeInternal(id, initCode, { silent: true });
    
    managed.info.status = 'idle';
    managed.executionCount = 0;
    return managed.info;
  }
  
  async interrupt(id: string): Promise<boolean> {
    const managed = this.kernels.get(id);
    if (!managed) return false;
    
    await managed.kernel.interrupt();
    managed.info.status = 'idle';
    return true;
  }
  
  async complete(id: string, code: string, cursorPos: number): Promise<KernelCompleteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }
    
    const reply = await managed.kernel.requestComplete({ code, cursor_pos: cursorPos });
    
    return {
      matches: reply.content.matches,
      cursor_start: reply.content.cursor_start,
      cursor_end: reply.content.cursor_end,
    };
  }
  
  async inspect(id: string, code: string, cursorPos: number): Promise<KernelInspectResult> {
    const managed = this. kernels.get(id);
    if (!managed) {
      return { found: false };
    }
    
    const reply = await managed.kernel.requestInspect({
      code,
      cursor_pos: cursorPos,
      detail_level: 0,
    });
    
    if (reply.content.status === 'ok' && reply.content.found) {
      return {
        found: true,
        data: reply.content.data as Record<string, string>,
      };
    }
    
    return { found:  false };
  }
}
```

**Notes:**
- Use `@jupyterlab/services` documentation:  https://jupyterlab.github.io/jupyterlab/services/
- Handle message types: `stream`, `execute_result`, `display_data`, `error`
- For custom executables, you may need to use `ServerConnection. makeSettings()` with kernel gateway or spawn kernels directly
- Init cells must execute silently (no output to console)

---

### Part 3: Environment Selector Dialog

**Location:** `electron/renderer/src/components/EnvironmentSelector/index.tsx` (NEW)

**Purpose:** GUI for users to configure Python/Julia executable paths. 

**Requirements:**

1. **Modal Dialog:**
   - Shows on first run (when no config exists)
   - Can be opened from menu/settings later
   - Blocks other UI until configured

2. **Input Fields:**
   - Python executable path (text input + file picker button)
   - Julia executable path (text input + file picker button)
   - Default values:  `python3` and `julia` (search PATH)

3. **Validation:**
   - Check that executables exist and are executable
   - Verify ipykernel is installed (run `python -m ipykernel --version`)
   - Verify IJulia is installed (run `julia -e 'using IJulia; println(IJulia. KERNEL_VERSION)'`)
   - Show error if validation fails

4. **Actions:**
   - "Test & Save" button — validates and saves to config
   - "Use Defaults" button — saves `python3`/`julia` without validation
   - "Cancel" button — only if not first run

**Component structure (pseudocode):**

```typescript
interface EnvironmentSelectorProps {
  isFirstRun: boolean;
  currentConfig?:  { pythonPath?: string; juliaPath?: string };
  onSave: (config: { pythonPath: string; juliaPath:  string }) => void;
  onCancel?:  () => void;
}

export const EnvironmentSelector: React.FC<EnvironmentSelectorProps> = ({
  isFirstRun,
  currentConfig,
  onSave,
  onCancel,
}) => {
  const [pythonPath, setPythonPath] = useState(currentConfig?.pythonPath || 'python3');
  const [juliaPath, setJuliaPath] = useState(currentConfig?.juliaPath || 'julia');
  const [validating, setValidating] = useState(false);
  const [errors, setErrors] = useState<{ python?: string; julia?: string }>({});
  
  const handleValidate = async () => {
    setValidating(true);
    setErrors({});
    
    // Validate Python
    const pythonValid = await window.pdv.kernels.validateExecutable(pythonPath, 'python');
    if (!pythonValid. valid) {
      setErrors(prev => ({ ...prev, python: pythonValid.error }));
    }
    
    // Validate Julia
    const juliaValid = await window.pdv.kernels.validateExecutable(juliaPath, 'julia');
    if (!juliaValid.valid) {
      setErrors(prev => ({ ...prev, julia: juliaValid.error }));
    }
    
    setValidating(false);
    
    if (pythonValid.valid && juliaValid.valid) {
      onSave({ pythonPath, juliaPath });
    }
  };
  
  const handleFilePicker = async (language: 'python' | 'julia') => {
    const result = await window.pdv.files.pickExecutable();
    if (result) {
      if (language === 'python') setPythonPath(result);
      else setJuliaPath(result);
    }
  };
  
  return (
    <div className="modal-overlay">
      <div className="environment-selector">
        <h2>Configure Runtime Environments</h2>
        
        {isFirstRun && (
          <p className="help-text">
            Please specify paths to Python and Julia executables with Jupyter kernels installed.
          </p>
        )}
        
        {/* Python input */}
        <div className="input-group">
          <label>Python Executable</label>
          <div className="input-with-button">
            <input
              type="text"
              value={pythonPath}
              onChange={(e) => setPythonPath(e.target.value)}
              placeholder="/usr/bin/python3"
            />
            <button onClick={() => handleFilePicker('python')}>Browse</button>
          </div>
          {errors.python && <div className="error-text">{errors.python}</div>}
          <div className="help-text">
            Requires ipykernel:  <code>pip install ipykernel</code>
          </div>
        </div>
        
        {/* Julia input */}
        <div className="input-group">
          <label>Julia Executable</label>
          <div className="input-with-button">
            <input
              type="text"
              value={juliaPath}
              onChange={(e) => setJuliaPath(e.target. value)}
              placeholder="/usr/local/bin/julia"
            />
            <button onClick={() => handleFilePicker('julia')}>Browse</button>
          </div>
          {errors.julia && <div className="error-text">{errors.julia}</div>}
          <div className="help-text">
            Requires IJulia: <code>using Pkg; Pkg.add("IJulia")</code>
          </div>
        </div>
        
        {/* Actions */}
        <div className="button-group">
          <button
            className="btn btn-primary"
            onClick={handleValidate}
            disabled={validating}
          >
            {validating ? 'Validating...' : 'Test & Save'}
          </button>
          
          <button
            className="btn btn-secondary"
            onClick={() => onSave({ pythonPath, juliaPath })}
          >
            Use Defaults (Skip Validation)
          </button>
          
          {! isFirstRun && onCancel && (
            <button className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
```

**Styling:**
- Modal overlay (dark semi-transparent background)
- Centered dialog box
- Input fields with file picker buttons
- Error messages in red below inputs
- Help text in secondary color

---

### Part 4: Validation IPC Handler

**Location:** `electron/main/index.ts`

**Add new IPC handler for executable validation:**

```typescript
ipcMain.handle('kernels:validate', async (_event, execPath, language) => {
  try {
    const { spawn } = require('child_process');
    
    // Check if executable exists and is runnable
    const checkCmd = language === 'python'
      ? [execPath, '-m', 'ipykernel', '--version']
      : [execPath, '-e', 'using IJulia; println(IJulia.KERNEL_VERSION)'];
    
    return new Promise((resolve) => {
      const proc = spawn(checkCmd[0], checkCmd.slice(1));
      let output = '';
      
      proc. stdout.on('data', (data) => output += data);
      proc.stderr.on('data', (data) => output += data);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ valid: true });
        } else {
          resolve({
            valid: false,
            error: `${language === 'python' ? 'ipykernel' : 'IJulia'} not found.  Output: ${output}`,
          });
        }
      });
      
      proc.on('error', (err) => {
        resolve({
          valid: false,
          error: `Failed to run ${execPath}: ${err.message}`,
        });
      });
    });
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
```

**Add to IPC types:**

```typescript
// In electron/main/ipc.ts
export const IPC = {
  kernels: {
    // ... existing
    validate: 'kernels: validate',
  },
  // ... 
};
```

**Add to preload:**

```typescript
// In electron/preload.ts
kernels: {
  // ...  existing
  validateExecutable: (path: string, language: 'python' | 'julia') =>
    ipcRenderer.invoke(IPC.kernels.validate, path, language),
}
```

---

### Part 5: Config Integration

**Update `electron/main/config.ts`:**

Add executable paths to Config type and persistence:

```typescript
export interface Config {
  kernelSpec: string | null;
  plotMode: 'native' | 'capture';
  cwd: string;
  trusted:  boolean;
  recentProjects?:  string[];
  customKernels?: KernelSpec[];
  // NEW: 
  pythonPath?:  string;
  juliaPath?:  string;
}

// Load from file or defaults
export function loadConfig(): Config {
  const configPath = path.join(app. getPath('userData'), 'config.json');
  
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (error) {
    console.error('[config] Failed to load:', error);
  }
  
  // Defaults
  return {
    kernelSpec: null,
    plotMode: 'native',
    cwd: process.cwd(),
    trusted: false,
    pythonPath: 'python3',
    juliaPath: 'julia',
  };
}

export function saveConfig(config: Config): void {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
```

---

### Part 6: Wire Environment Selector into App

**Location:** `electron/renderer/src/app/index.tsx`

**Add state and logic:**

```typescript
const [showEnvSelector, setShowEnvSelector] = useState(false);
const [config, setConfig] = useState<Config | null>(null);

// On mount, load config and check if first run
useEffect(() => {
  const initConfig = async () => {
    const cfg = await window.pdv.config.get();
    setConfig(cfg);
    
    // Show selector if no executable paths configured
    if (!cfg.pythonPath || !cfg.juliaPath) {
      setShowEnvSelector(true);
    } else {
      // Start default kernel
      startKernel(cfg);
    }
  };
  
  initConfig();
}, []);

const handleEnvSave = async (paths: { pythonPath: string; juliaPath: string }) => {
  const updatedConfig = { ...config, ... paths };
  await window.pdv.config.set(updatedConfig);
  setConfig(updatedConfig);
  setShowEnvSelector(false);
  
  // Start kernel with new config
  startKernel(updatedConfig);
};

const startKernel = async (cfg: Config) => {
  try {
    const kernel = await window.pdv.kernels.start({
      language: 'python',
      argv: [cfg.pythonPath!, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    });
    setCurrentKernelId(kernel.id);
  } catch (error) {
    console.error('[App] Failed to start kernel:', error);
  }
};

// Render
return (
  <div className="app">
    {showEnvSelector && (
      <EnvironmentSelector
        isFirstRun={!config?. pythonPath}
        currentConfig={config || {}}
        onSave={handleEnvSave}
      />
    )}
    
    {/* ... rest of app */}
  </div>
);
```

---

### Part 7: Update Tests

**Update `electron/main/kernel-manager.test.ts`:**

Tests should now work with real kernels if available, or skip if not: 

```typescript
describe('KernelManager (Real)', () => {
  // Check if kernels are available
  const hasKernels = process.env.CI !== 'true';  // Skip in CI
  
  it. skipIf(! hasKernels)('should start a real Python kernel', async () => {
    const manager = new KernelManager();
    const kernel = await manager.start({ language: 'python' });
    
    expect(kernel.id).toBeDefined();
    expect(kernel. status).toBe('idle');
    
    await manager.stop(kernel.id);
  });
  
  it.skipIf(! hasKernels)('should execute real Python code', async () => {
    const manager = new KernelManager();
    const kernel = await manager. start({ language: 'python' });
    
    const result = await manager.execute(kernel.id, { code: 'print("real!")' });
    
    expect(result.stdout).toContain('real!');
    expect(result.error).toBeUndefined();
    
    await manager.stop(kernel.id);
  });
});
```

---

## Exit Criteria

After completing this step, verify: 

1. **Dependencies installed:**
   ```bash
   cd electron
   npm install
   ```
   Check that `@jupyterlab/services` is in node_modules. 

2. **Build succeeds:**
   ```bash
   npm run build
   ```

3. **Environment selector appears:**
   ```bash
   npm run dev
   ```
   - On first run, modal appears asking for Python/Julia paths
   - Can enter paths or click "Use Defaults"
   - "Test & Save" validates executables

4. **Real kernel starts:**
   - After saving config, app starts a Python kernel
   - Status bar shows "Idle" (not stuck on "Starting")
   - Check terminal for kernel logs

5. **Real execution works:**
   - In Monaco, type:  `print("Hello from real Python!")`
   - Press Ctrl/Cmd+Enter
   - Console shows: `Hello from real Python!`
   - Try: `import sys; sys.version` → shows actual Python version

6. **Advanced execution:**
   ```python
   import numpy as np
   x = np.random.rand(100)
   x. mean()
   ```
   - Shows real computed mean value

7. **Variables persist:**
   ```python
   # First execution
   data = [1, 2, 3, 4, 5]
   
   # Second execution
   sum(data)  # Returns 15
   ```

8. **Errors handled:**
   ```python
   1 / 0
   ```
   - Console shows: `ZeroDivisionError: division by zero`
   - Error bar appears with error message

9. **Interrupts work:**
   ```python
   import time
   for i in range(1000):
       print(i)
       time.sleep(0.1)
   ```
   - Click interrupt (if button exists) or Ctrl+C
   - Execution stops

10. **Completions work:**
    - Type `imp` in Monaco
    - Completions suggest `import`
    - Type `numpy. ` → suggests numpy methods

11. **Julia works (if installed):**
    - Update config with Julia path
    - Restart kernel with Julia
    - Execute:  `println("Hello from Julia!")`

---

## Files to Create/Modify (Checklist)

- [ ] `electron/package.json` — Add @jupyterlab/services dependency
- [ ] `electron/main/kernel-manager.ts` — Replace with real implementation
- [ ] `electron/main/ipc.ts` — Add validate channel
- [ ] `electron/main/index.ts` — Add validation handler
- [ ] `electron/main/config.ts` — Add pythonPath/juliaPath to Config
- [ ] `electron/preload.ts` — Add validateExecutable method
- [ ] `electron/renderer/src/components/EnvironmentSelector/index.tsx` — NEW
- [ ] `electron/renderer/src/app/index.tsx` — Wire environment selector
- [ ] `electron/renderer/src/styles/index.css` — Add modal/dialog styles
- [ ] `electron/main/kernel-manager.test.ts` — Update for real kernels

---

## Notes

- **Kernel Discovery:** `@jupyterlab/services` can discover installed kernelspecs automatically.  For custom paths, you may need to set environment variables or use a kernel gateway. 

- **Connection Files:** Jupyter kernels communicate via ZMQ sockets defined in connection files. `@jupyterlab/services` handles this automatically.

- **Server vs Direct:** Two options:
  - **Option A (simpler):** Start a local Jupyter server and connect to it
  - **Option B (what we're doing):** Use `@jupyterlab/services` to spawn kernels directly
  
- **Custom Executables:** To use a custom Python/Julia executable, you may need to:
  - Set `JUPYTER_PATH` environment variable
  - Create a custom kernelspec JSON file pointing to the executable
  - Or use kernel gateway with custom spawn logic

- **Init Cell Timing:** Ensure init cell executes **after** kernel is ready but **before** returning from `start()`. Use `silent: true` to avoid polluting console.

- **Message Parsing:** Jupyter messages are complex. Focus on key types:
  - `stream` → stdout/stderr
  - `execute_result` → return value
  - `display_data` → rich output (images, HTML)
  - `error` → exceptions

- **Performance:** Real kernel startup takes 1-3 seconds. Show "Starting kernel..." in status bar.

- **Debugging:** Enable verbose logging: 
  ```typescript
  console.log('[KernelManager] Message:', msg. header.msg_type, msg.content);
  ```

- **Security:** Validate user-provided executable paths to prevent command injection.

- **Future:** Add support for remote kernels (Jupyter server URL + token).

---

## Testing Tips

**Manual test sequence:**

1. Delete config:  `rm ~/Library/Application\ Support/physics-data-viewer/config.json` (macOS) or equivalent
2. Launch app → environment selector appears
3. Enter paths (or use defaults) → click "Test & Save"
4. Wait for kernel to start (~2 seconds)
5. Status bar shows "Idle"
6. Type in Monaco: `1 + 1` → Execute → Console shows `2`
7. Type: `import numpy as np; np.__version__` → shows version
8. Type: `print("test")` → Console shows `test`
9. Restart app → config persists, no selector shown
10. Kernel auto-starts with saved paths

**Common issues:**

- **Kernel won't start:** Check that ipykernel/IJulia is installed in the specified Python/Julia environment
- **No output:** Check message handler for `stream` messages
- **Timeout:** Increase timeout or check kernel logs
- **Path issues:** Ensure executable is in PATH or use absolute path

**Verify init cells run:**
```python
# Should be in namespace after kernel starts
pdv_show
pdv_info
# These functions defined in python-init.py
```