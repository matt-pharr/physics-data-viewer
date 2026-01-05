"""
Physics Data Viewer - Python Kernel Initialization

This file is executed when a Python kernel starts.
It sets up the environment, configures plot backends, and defines helper functions.
"""

# =============================================================================
# Standard Imports (always available in namespace)
# =============================================================================

# Uncomment these once real kernel integration is done:
# import sys
# import os
# import io
# import base64

# =============================================================================
# Matplotlib Backend Configuration
# =============================================================================

def _pdv_setup_matplotlib(capture_mode=False):
    """
    Configure matplotlib backend based on capture mode.

    Args:
        capture_mode: If True, use Agg backend for image capture.
                      If False, use interactive backend (Qt/MacOSX/Tk).
    """
    try:
        import matplotlib

        if capture_mode:
            # Non-interactive backend for capturing figures
            matplotlib.use('Agg')
            print("[PDV] Matplotlib backend: Agg (capture mode)")
        else:
            # Try interactive backends in order of preference
            backends_to_try = ['QtAgg', 'Qt5Agg', 'MacOSX', 'TkAgg', 'Agg']

            for backend in backends_to_try:
                try:
                    matplotlib.use(backend)
                    print(f"[PDV] Matplotlib backend: {backend}")
                    break
                except Exception:
                    continue
            else:
                print("[PDV] Warning: No interactive matplotlib backend available")

    except ImportError:
        print("[PDV] Matplotlib not installed")

# =============================================================================
# Plot Capture Helper
# =============================================================================

def pdv_show(fig=None, fmt='png', dpi=100):
    """
    Capture a matplotlib figure and return it as base64 for display in PDV UI.

    Args:
        fig: The figure to capture. If None, uses the current figure.
        fmt: Output format ('png' or 'svg').
        dpi: Resolution for raster formats.

    Returns:
        dict: {'mime': 'image/png', 'data': '<base64 string>'}

    Example:
        >>> import matplotlib.pyplot as plt
        >>> plt.plot([1, 2, 3], [1, 4, 9])
        >>> pdv_show()  # Captures and returns the figure
    """
    try:
        import matplotlib.pyplot as plt
        import io
        import base64

        if fig is None:
            fig = plt.gcf()

        buf = io.BytesIO()
        fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches='tight')
        buf.seek(0)
        data = base64.b64encode(buf.read()).decode('utf-8')
        buf.close()

        # Optionally close the figure to free memory
        # plt.close(fig)

        return {'mime': f'image/{fmt}', 'data': data}

    except ImportError:
        return {'error': 'matplotlib not installed'}
    except Exception as e:
        return {'error': str(e)}

# =============================================================================
# Data Inspection Helpers
# =============================================================================

def pdv_info(obj):
    """
    Get detailed information about an object for display in the Tree.

    Returns:
        dict: Object metadata including type, shape, dtype, preview, etc.
    """
    info = {
        'type': type(obj).__name__,
        'module': type(obj).__module__,
    }

    # NumPy arrays
    if hasattr(obj, 'shape') and hasattr(obj, 'dtype'):
        info['shape'] = list(obj.shape)
        info['dtype'] = str(obj.dtype)
        info['size'] = obj.nbytes if hasattr(obj, 'nbytes') else None
        info['preview'] = f"{obj.dtype} {tuple(obj.shape)}"

    # Pandas DataFrames
    elif hasattr(obj, 'columns') and hasattr(obj, 'index'):
        info['shape'] = list(obj.shape)
        info['columns'] = list(obj.columns)
        info['preview'] = f"DataFrame ({len(obj)} rows, {len(obj.columns)} cols)"

    # Pandas Series
    elif hasattr(obj, 'index') and hasattr(obj, 'dtype') and not hasattr(obj, 'columns'):
        info['shape'] = [len(obj)]
        info['dtype'] = str(obj.dtype)
        info['preview'] = f"Series ({len(obj)}) [{obj.dtype}]"

    # Lists, tuples, sets
    elif isinstance(obj, (list, tuple, set)):
        info['length'] = len(obj)
        info['preview'] = f"{type(obj).__name__} ({len(obj)} items)"

    # Dicts
    elif isinstance(obj, dict):
        info['length'] = len(obj)
        info['keys'] = list(obj.keys())[:10]  # First 10 keys
        info['preview'] = f"dict ({len(obj)} items)"

    # Strings
    elif isinstance(obj, str):
        info['length'] = len(obj)
        info['preview'] = repr(obj[:50]) + ('...' if len(obj) > 50 else '')

    # Numbers
    elif isinstance(obj, (int, float, complex)):
        info['preview'] = repr(obj)

    else:
        info['preview'] = repr(obj)[:100]

    return info

# =============================================================================
# Namespace Management
# =============================================================================

def pdv_namespace():
    """
    Get the current namespace as a dict suitable for the Tree view.
    Filters out private variables, modules, and built-ins.
    """
    import sys

    # Get the main namespace (this is a stub; real impl gets IPython's namespace)
    namespace = {}

    # Filter and process
    result = {}
    for name, obj in namespace.items():
        # Skip private and dunder names
        if name.startswith('_'):
            continue
        # Skip modules
        if isinstance(obj, type(sys)):
            continue
        # Skip callables (functions, classes) unless explicitly requested
        if callable(obj) and not hasattr(obj, 'shape'):
            continue

        result[name] = pdv_info(obj)

    return result

# =============================================================================
# Initialization
# =============================================================================

# Set up matplotlib with native windows by default
# _pdv_setup_matplotlib(capture_mode=False)

print("Physics Data Viewer Python kernel initialized.")
print("  - pdv_show(): Capture current figure")
print("  - pdv_info(obj): Get object metadata")
