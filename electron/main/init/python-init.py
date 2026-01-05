"""
Physics Data Viewer - Python Kernel Initialization

This file is executed when a Python kernel starts.
It sets up the environment, configures plot backends, and defines helper functions.
"""

import sys
import os

MAX_COLUMNS = 20
MAX_PREVIEW_LENGTH = 100

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
            print("[PDV] Matplotlib backend: Agg (capture mode)")
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

    Args:
        fig: The figure to capture. If None, uses the current figure.
        fmt: Output format ('png' or 'svg').
        dpi: Resolution for raster formats.
        close: If True, close the figure after capture.

    Returns:
        dict: {'mime': 'image/png', 'data': '<base64 string>'}
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

        if not fig.get_axes():
            return {'error': 'No plot to capture (figure is empty)'}

        buf = io.BytesIO()
        fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches='tight')
        buf.seek(0)
        data = base64.b64encode(buf.read()).decode('utf-8')
        buf.close()

        if close:
            plt.close(fig)

        return {'mime': f'image/{fmt}', 'data': data}

    except ImportError:
        return {'error': 'matplotlib not installed'}
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
            _ = (args, kwargs)
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
                    print(f"[PDV] Plot captured: {result['mime']}")
            else:
                print(f"[PDV] Error capturing plot: {result['error']}")

            return result

        plt.show = _captured_show
        print("[PDV] Auto-capture enabled: plt.show() will capture plots")

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
            print("[PDV] Auto-capture disabled: plt.show() restored to native")
        except ImportError:
            pass

# =============================================================================
# Namespace Management
# =============================================================================

def pdv_namespace(include_private=False, include_modules=False, include_callables=False):
    """
    Get the current namespace as a dict suitable for the Namespace view.
    Inclusion flags control which categories are returned.
    
    Args:
        include_private:  If False, exclude variables starting with '_'
        include_modules: If False, exclude module objects
        include_callables: If False, exclude functions and classes
    
    Returns:
        dict: Variable name -> metadata dict
    """
    import sys
    import inspect
    
    # Get IPython namespace if available, otherwise use globals()
    try:
        ipython_fn = globals().get('get_ipython')
        if callable(ipython_fn):
            namespace = ipython_fn().user_ns
        else:
            namespace = globals()
    except Exception:
        namespace = globals()
    
    result = {}
    
    for name, obj in namespace.items():
        # Skip private variables (unless requested)
        if not include_private and name.startswith('_'):
            continue
        
        # Skip modules (unless requested)
        if not include_modules and inspect.ismodule(obj):
            continue
        
        # Skip callables (unless requested)
        if not include_callables and callable(obj) and not hasattr(obj, 'shape'):
            continue
        
        # Skip PDV internals
        if name.startswith('pdv_') or name.startswith('_pdv_'):
            continue
        
        # Get metadata using pdv_info
        try:
            info = pdv_info(obj)
            result[name] = info
        except Exception as e:
            # Fallback for objects that can't be inspected
            result[name] = {
                'type': type(obj).__name__,
                'preview': str(obj)[:MAX_PREVIEW_LENGTH],
                'error': f'Could not inspect: {str(e)}'
            }
    
    return result

# Update pdv_info to handle more types
def pdv_info(obj):
    """
    Get detailed information about an object for display in the Tree/Namespace. 
    
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
        
        # Add min/max/mean for numeric arrays
        try:
            if obj.size > 0 and obj.dtype.kind in ['i', 'u', 'f', 'c']:
                info['min'] = float(obj.min())
                info['max'] = float(obj.max())
                info['mean'] = float(obj.mean())
        except:
            pass
    
    # Pandas DataFrames
    elif hasattr(obj, 'columns') and hasattr(obj, 'index'):
        info['shape'] = list(obj.shape)
        info['columns'] = list(obj.columns)[:MAX_COLUMNS]
        info['preview'] = f"DataFrame ({len(obj)} rows, {len(obj.columns)} cols)"
        info['size'] = int(obj.memory_usage(deep=False).sum()) if hasattr(obj, 'memory_usage') else None
    
    # Pandas Series
    elif hasattr(obj, 'index') and hasattr(obj, 'dtype') and not hasattr(obj, 'columns'):
        info['shape'] = [len(obj)]
        info['dtype'] = str(obj.dtype)
        info['preview'] = f"Series ({len(obj)}) [{obj.dtype}]"
        info['size'] = int(obj.memory_usage(deep=False)) if hasattr(obj, 'memory_usage') else None
    
    # Lists, tuples, sets
    elif isinstance(obj, (list, tuple, set)):
        info['length'] = len(obj)
        info['preview'] = f"{type(obj).__name__} ({len(obj)} items)"
        
        # Show first few elements
        if len(obj) > 0:
            try:
                items = list(obj)[:3] if isinstance(obj, set) else obj[:3]
                items_str = ', '.join(repr(item)[:20] for item in items)
                if len(obj) > 3:
                    items_str += ', ...'
                info['preview'] += f":  [{items_str}]"
            except:
                pass
    
    # Dicts
    elif isinstance(obj, dict):
        info['length'] = len(obj)
        info['keys'] = list(obj.keys())[:10]  # First 10 keys
        info['preview'] = f"dict ({len(obj)} items)"
    
    # Strings
    elif isinstance(obj, str):
        info['length'] = len(obj)
        preview = obj[:50]
        if len(obj) > 50:
            preview += '...'
        info['preview'] = repr(preview)
    
    # Numbers
    elif isinstance(obj, (int, float, complex)):
        info['preview'] = repr(obj)
    
    # Booleans
    elif isinstance(obj, bool):
        info['preview'] = repr(obj)
    
    # None
    elif obj is None: 
        info['preview'] = 'None'
    
    # Matplotlib figures
    elif type(obj).__name__ == 'Figure':
        info['preview'] = f"Figure ({obj.get_figwidth()}x{obj.get_figheight()} in)"
        info['num_axes'] = len(obj.get_axes())
    
    # Generic objects
    else:
        info['preview'] = repr(obj)[:MAX_PREVIEW_LENGTH]
    
    return info

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
print("  - pdv_show(): Capture current figure")
print("  - pdv_info(obj): Get object metadata")
print(f"  - Capture mode: {'enabled' if _capture_mode else 'disabled'}")
