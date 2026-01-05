# Agent Task: Step 6 - Plot Mode & Capture Integration

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.  Step 5. 5 integrated real Jupyter kernels via **direct ZMQ connections** (no Jupyter server). The app launches kernels as child processes, connects via `zeromq`, and implements the Jupyter wire protocol manually.

**Your task is to make plot capture work with real kernels, configure matplotlib/Plots.jl backends based on plot mode, implement `pdv_show()` helper functions, and display captured images in the Console.**

**Reference files you should read first:**
- `PLAN.md` — Plot handling architecture, direct ZMQ kernel architecture
- `electron/main/kernel-manager.ts` — Current KernelManager with direct ZMQ execution
- `electron/main/init/python-init.py` — Python init cell (needs backend config)
- `electron/main/init/julia-init.jl` — Julia init cell (needs backend config)
- `electron/renderer/src/components/Console/index.tsx` — Console component (needs image rendering)

**Current state:**
- Real kernels execute Python/Julia code via direct ZMQ connections
- KernelManager listens to IOPub socket for output messages
- Plot mode toggle exists in UI but doesn't affect behavior
- Init cells have placeholder comments for backend config
- `display_data` messages with images not handled in IOPub listener
- Console doesn't render images

**After this step:**
- **Native mode (default):** `plt.show()` opens external window, no image captured
- **Capture mode:** `plt.show()` captures PNG/SVG, sends via `display_data` on IOPub, appears in Console
- `pdv_show()` helper works in both languages
- Images display inline in Console
- Plot mode toggle persists in config and affects kernel startup

---

## Your Task

### Part 1: Update Python Init Cell

**Location:** `electron/main/init/python-init.py`

**Requirements:**

1. **Backend Configuration Function:**
   - Detect if running in capture mode (check environment variable `PDV_CAPTURE_MODE`)
   - If capture mode: use `Agg` backend (non-interactive)
   - If native mode: try `QtAgg` → `Qt5Agg` → `MacOSX` → `TkAgg` → fallback to `Agg`
   - Log which backend was selected

2. **`pdv_show()` Implementation:**
   - Capture current matplotlib figure
   - Return dict with base64-encoded PNG or SVG
   - Close figure after capture (optional, configurable)
   - Handle errors gracefully (empty figure, no matplotlib, etc.)

3. **Auto-capture Hook (Optional):**
   - Monkey-patch `plt.show()` in capture mode to automatically call `pdv_show()`
   - Use IPython `display()` if available to send `display_data` message
   - This makes `plt.show()` work transparently in capture mode

**Implementation guidance:**

```python
# electron/main/init/python-init.py

"""
Physics Data Viewer - Python Kernel Initialization

Configures matplotlib backend and defines plot capture helpers.  
"""

import sys
import os

# =============================================================================
# Matplotlib Backend Configuration
# =============================================================================

def _pdv_setup_matplotlib(capture_mode=False):
    """
    Configure matplotlib backend based on capture mode.
    
    Args:
        capture_mode: If True, use Agg backend for image capture.  
                     If False, use interactive backend.
    """
    try:
        import matplotlib
        
        if capture_mode:
            matplotlib.use('Agg')
            print("[PDV] Matplotlib backend:  Agg (capture mode)")
        else:
            # Try interactive backends in order of preference
            backends_to_try = ['QtAgg', 'Qt5Agg', 'MacOSX', 'TkAgg']
            
            for backend in backends_to_try:
                try:
                    matplotlib.use(backend)
                    print(f"[PDV] Matplotlib backend: {backend} (native mode)")
                    break
                except Exception: 
                    continue
            else:
                # Fallback to Agg if no interactive backend available
                matplotlib.use('Agg')
                print("[PDV] Warning: No interactive backend available, using Agg")
                
    except ImportError:
        print("[PDV] Warning: matplotlib not installed")

# =============================================================================
# Plot Capture Helper
# =============================================================================

def pdv_show(fig=None, fmt='png', dpi=100, close=True):
    """
    Capture a matplotlib figure and return it as base64 for display in PDV.
    
    In capture mode, this is called automatically by plt.show().
    In native mode, call explicitly to capture a figure inline.
    
    Args:
        fig: The figure to capture.  If None, uses current figure.  
        fmt: Output format ('png' or 'svg').
        dpi: Resolution for raster formats.
        close: If True, close the figure after capture. 
    
    Returns:
        dict: {'mime':  'image/png', 'data': '<base64 string>'}
             or {'error': '<error message>'}
    
    Example:
        >>> import matplotlib.pyplot as plt
        >>> plt.plot([1, 2, 3], [1, 4, 9])
        >>> result = pdv_show()  # Captures and returns the figure
    """
    try:
        import matplotlib.pyplot as plt
        import io
        import base64
        
        if fig is None:
            fig = plt.gcf()
        
        # Check if figure is empty
        if not fig.get_axes():
            return {'error': 'No plot to capture (figure is empty)'}
        
        # Capture to buffer
        buf = io.BytesIO()
        fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches='tight')
        buf.seek(0)
        data = base64.b64encode(buf.read()).decode('utf-8')
        buf.close()
        
        # Optionally close the figure
        if close:
            plt.close(fig)
        
        return {'mime': f'image/{fmt}', 'data': data}
        
    except ImportError:
        return {'error':  'matplotlib not installed'}
    except Exception as e:
        return {'error': f'Failed to capture plot: {str(e)}'}

# =============================================================================
# Auto-Capture Hook
# =============================================================================

_pdv_original_show = None
_pdv_capture_mode = False

def _pdv_enable_auto_capture():
    """
    Monkey-patch plt.show() to automatically capture in capture mode.
    Uses IPython display() to send display_data message to frontend.
    """
    global _pdv_original_show, _pdv_capture_mode
    
    try:
        import matplotlib.pyplot as plt
        
        if _pdv_original_show is None:
            _pdv_original_show = plt.show
        
        _pdv_capture_mode = True
        
        def _captured_show(*args, **kwargs):
            """Replacement for plt.show() that captures instead of displaying"""
            result = pdv_show(close=False)
            
            if 'error' not in result:
                # Send display_data message via IPython if available
                try:
                    from IPython.display import display, Image
                    import base64
                    img_data = base64.b64decode(result['data'])
                    display(Image(data=img_data, format='png'))
                except ImportError:
                    # No IPython, just print result
                    print(f"[PDV] Plot captured:  {result['mime']}")
            else:
                print(f"[PDV] Error capturing plot: {result['error']}")
            
            return result
        
        plt.show = _captured_show
        print("[PDV] Auto-capture enabled:  plt.show() will capture plots")
        
    except ImportError:
        print("[PDV] Warning: matplotlib not available for auto-capture")

def _pdv_disable_auto_capture():
    """Restore original plt.show() behavior"""
    global _pdv_original_show, _pdv_capture_mode
    
    if _pdv_original_show is not None:
        try:
            import matplotlib.pyplot as plt
            plt.show = _pdv_original_show
            _pdv_capture_mode = False
            print("[PDV] Auto-capture disabled:  plt.show() restored to native")
        except ImportError:
            pass

# =============================================================================
# Initialization
# =============================================================================

# Check if capture mode is enabled via environment variable
_capture_mode = os.environ.get('PDV_CAPTURE_MODE', '').lower() == 'true'

# Configure matplotlib backend
_pdv_setup_matplotlib(capture_mode=_capture_mode)

# Enable auto-capture if in capture mode
if _capture_mode:
    _pdv_enable_auto_capture()

print("Physics Data Viewer Python kernel initialized.")
print("  - pdv_show(fig): Capture figure as base64 PNG/SVG")
print(f"  - Capture mode: {'enabled' if _capture_mode else 'disabled'}")
```

---

### Part 2: Update Julia Init Cell

**Location:** `electron/main/init/julia-init.jl`

**Requirements:**

1. **Backend Configuration Function:**
   - Detect capture mode (check ENV["PDV_CAPTURE_MODE"])
   - If capture mode: configure GR with `show=false`
   - If native mode: use GR or GLMakie with native display

2. **`pdv_show()` Implementation:**
   - Capture current plot
   - Return Dict with base64-encoded PNG or SVG
   - Handle errors gracefully

**Implementation guidance:**

```julia
# electron/main/init/julia-init.jl

#=
Physics Data Viewer - Julia Kernel Initialization

Configures Plots.jl backend and defines plot capture helpers. 
=#

# =============================================================================
# Plot Backend Configuration
# =============================================================================

"""
    _pdv_setup_plots(capture_mode::Bool=false)

Configure Plots.jl backend based on capture mode.  

# Arguments
- `capture_mode`: If true, configure for image capture; otherwise use interactive display.  
"""
function _pdv_setup_plots(capture_mode::Bool=false)
    try
        using Plots
        
        if capture_mode
            # Use GR with no display for capturing
            gr(show=false, size=(800, 600))
            println("[PDV] Plots backend: GR (capture mode, show=false)")
        else
            # Use GR with interactive display
            gr(size=(800, 600))
            println("[PDV] Plots backend: GR (native mode)")
        end
    catch e
        println("[PDV] Warning: Plots. jl not installed:  $e")
    end
end

# =============================================================================
# Plot Capture Helper
# =============================================================================

"""
    pdv_show(p=nothing; fmt=: png, dpi=100)

Capture a plot and return it as base64 for display in PDV.

# Arguments
- `p`: The plot to capture. If nothing, uses the current plot.
- `fmt`: Output format (`:png` or `:svg`).
- `dpi`: Resolution for raster formats.  

# Returns
- `Dict`: `{"mime" => "image/png", "data" => "<base64 string>"}`
         or `{"error" => "<error message>"}`

# Example
```julia
using Plots
plot([1, 2, 3], [1, 4, 9])
pdv_show()  # Captures and returns the figure
```
"""
function pdv_show(p=nothing; fmt=:png, dpi=100)
    try
        using Plots
        using Base64
        
        if p === nothing
            p = Plots.current()
        end
        
        # Check if plot is empty
        if length(p.series_list) == 0
            return Dict("error" => "No plot to capture (plot is empty)")
        end
        
        # Capture to buffer
        io = IOBuffer()
        if fmt == :png
            savefig(p, io, : png; dpi=dpi)
        elseif fmt == :svg
            savefig(p, io, :svg)
        else
            return Dict("error" => "Unsupported format:  $fmt (use :png or :svg)")
        end
        
        # Encode to base64
        seekstart(io)
        data = base64encode(take!(io))
        
        return Dict("mime" => "image/$fmt", "data" => data)
        
    catch e
        return Dict("error" => "Failed to capture plot: $e")
    end
end

# =============================================================================
# Initialization
# =============================================================================

# Check if capture mode is enabled via environment variable
_capture_mode = get(ENV, "PDV_CAPTURE_MODE", "") == "true"

# Configure Plots backend
_pdv_setup_plots(_capture_mode)

println("Physics Data Viewer Julia kernel initialized.")
println("  - pdv_show(p): Capture plot as base64 PNG/SVG")
println("  - Capture mode: $(_capture_mode ? "enabled" :  "disabled")")
```

---

### Part 3: Update KernelManager to Pass Capture Mode

**Location:** `electron/main/kernel-manager. ts`

**Changes needed:**

1. **Set environment variable when spawning kernel:**
   - Get plot mode from config
   - Pass `PDV_CAPTURE_MODE=true` or `false` in kernel process environment

2. **Handle `display_data` messages in IOPub listener:**
   - Extract images from `msg.content. data['image/png']` or `msg.content.data['image/svg+xml']`
   - Add to `result.images` array
   - Images are already base64-encoded in Jupyter protocol

**Pseudocode additions:**

```typescript
// In KernelManager.start()
async start(spec?:  Partial<KernelSpec>): Promise<KernelInfo> {
  // ... existing connection file creation ...
  
  // Get plot mode from config
  const config = await loadConfig();  // Or however you access config
  const captureMode = config.plotMode === 'capture';
  
  // Set environment variables for kernel process
  const env = {
    ... process.env,
    PDV_CAPTURE_MODE: captureMode ?  'true' : 'false',
  };
  
  // Spawn kernel with environment
  const kernelProcess = spawn(executablePath, args, {
    env,
    cwd: config.cwd || process.cwd(),
  });
  
  // ... rest of start logic ...
}

// In execute(), update IOPub message handler:
// (This should already be listening to IOPub socket)

iopubSocket.on('message', (...frames) => {
  const msg = this.parseMessage(frames);  // Your existing parse logic
  
  const msgType = msg.header.msg_type;
  const parentMsgId = msg.parent_header?. msg_id;
  
  // Only collect messages for our execution
  if (parentMsgId !== executeMsgId) return;
  
  if (msgType === 'stream') {
    const content = msg.content as { name: string; text: string };
    if (content.name === 'stdout') {
      result.stdout += content.text;
    } else if (content.name === 'stderr') {
      result.stderr += content.text;
    }
  } else if (msgType === 'execute_result') {
    const content = msg.content as { data: Record<string, any> };
    result.result = content.data['text/plain'];
  } else if (msgType === 'display_data') {
    // NEW: Handle display_data for images
    const content = msg.content as { data: Record<string, any> };
    
    if (content.data) {
      // Check for image/png
      if (content.data['image/png']) {
        result.images = result.images || [];
        result. images.push({
          mime: 'image/png',
          data: content. data['image/png'],  // Already base64
        });
      }
      
      // Check for image/svg+xml
      if (content.data['image/svg+xml']) {
        result.images = result.images || [];
        result.images.push({
          mime: 'image/svg+xml',
          data:  content.data['image/svg+xml'],
        });
      }
    }
  } else if (msgType === 'error') {
    const content = msg.content as { ename: string; evalue: string; traceback: string[] };
    result.error = `${content.ename}: ${content.e