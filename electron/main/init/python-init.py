"""
Physics Data Viewer - Python Kernel Initialization

This file is executed when a Python kernel starts.
It sets up the environment, configures plot backends, and defines helper functions.
"""

import sys
import os
import re
import ast

MAX_COLUMNS = 20
MAX_PREVIEW_LENGTH = 100

# =============================================================================
# PDV Tree Object (Enhanced Dict)
# =============================================================================

class PDVTree(dict):
    """
    Enhanced dict that acts as the tree object in kernel namespace.
    Provides methods for running scripts, loading data, etc.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._project_root = None
        self._tree_root = None

    def _set_project_root(self, root):
        """Internal: set project root path"""
        import os
        self._project_root = root
        self._tree_root = os.path.join(root, 'tree')

    def run_script(self, script_path, **kwargs):
        """
        Execute a script file with parameters.

        Args:
            script_path: Path in tree (e.g., 'scripts.analysis.fit_model')
            **kwargs: Parameters to pass to script's run() function

        Returns:
            Result from script's run() function
        """
        import os
        import importlib.util

        path_parts = script_path.split('.')
        if any(part in ('', '.', '..') or '/' in part or '\\' in part for part in path_parts):
            raise ValueError(f"Invalid script path: {script_path}")
        file_path = os.path.join(self._tree_root, *path_parts) + '.py'
        normalized_path = os.path.realpath(file_path)
        if not normalized_path.startswith(os.path.realpath(self._tree_root)):
            raise ValueError(f"Script path escapes project tree: {script_path}")

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Script not found: {file_path}")

        spec = importlib.util.spec_from_file_location("_pdv_script", file_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Failed to load script: {file_path}")

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        if not hasattr(module, 'run'):
            raise AttributeError(f"Script {script_path} does not have a run() function")

        return module.run(self, **kwargs)

    def __getitem__(self, key):
        """Override to support path navigation (e.g., tree['data.array1'])"""
        if isinstance(key, str) and '.' in key:
            keys = key.split('.')
            obj = self
            for k in keys:
                obj = dict.__getitem__(obj, k)
            return obj
        return dict.__getitem__(self, key)

    def __setitem__(self, key, value):
        """Override to support path setting"""
        if isinstance(key, str) and '.' in key:
            keys = key.split('.')
            obj = self
            for k in keys[:-1]:
                if k not in obj:
                    obj[k] = PDVTree()
                obj = obj[k]
            dict.__setitem__(obj, keys[-1], value)
        else:
            dict.__setitem__(self, key, value)


class PDVScript:
    """Lightweight script wrapper stored inside the PDV tree"""

    def __init__(self, file_path, language='python', doc=None):
        self.file_path = file_path
        self.language = language
        self.doc = doc if doc is not None else _pdv_extract_docstring(file_path)

    def preview(self):
        if self.doc:
            return self.doc.split('\n')[0]
        return "PDV script"


# Create global tree instance
tree = PDVTree()

# Set project root (will be injected by PDV)
import os
tree._set_project_root(os.environ.get('PDV_PROJECT_ROOT', os.getcwd()))

# Initialize tree structure
if 'data' not in tree:
    tree['data'] = PDVTree()
if 'scripts' not in tree:
    tree['scripts'] = PDVTree()
if 'results' not in tree:
    tree['results'] = PDVTree()


# =============================================================================
# Tree Helpers
# =============================================================================

def _pdv_extract_docstring(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        try:
            module = ast.parse(content)
            doc = ast.get_docstring(module)
            if doc:
                return doc.strip().split('\n')[0]
        except Exception:
            pass
        match = re.search(r'"""([\s\S]*?)"""', content, re.M)
        if not match:
            match = re.search(r"'''([\s\S]*?)'''", content, re.M)
        if match:
            return match.group(1).strip().split('\n')[0]
    except Exception:
        return None
    return None


def _pdv_resolve_tree_path(path):
    if not path:
        return tree
    parts = [p for p in path.split('.') if p]
    obj = tree
    for part in parts:
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        elif isinstance(obj, (list, tuple)):
            try:
                idx = int(part)
                obj = obj[idx]
            except Exception:
                return None
        elif isinstance(obj, set):
            try:
                idx = int(part)
                obj = list(sorted(obj, key=lambda x: repr(x)))[idx]
            except Exception:
                return None
        else:
            return None
    return obj


def _pdv_node_type(value, info):
    if isinstance(value, PDVScript):
        return 'script'
    if isinstance(value, dict):
        return 'dict'
    if isinstance(value, list):
        return 'list'
    if isinstance(value, tuple):
        return 'tuple'
    if isinstance(value, set):
        return 'set'
    if info.get('columns'):
        return 'dataframe'
    if info.get('dtype') and info.get('shape') is not None:
        return 'ndarray'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, str):
        return 'string'
    if value is None:
        return 'none'
    if isinstance(value, (int, float, complex)):
        return 'number'
    return str(info.get('type') or type(value).__name__).lower() or 'unknown'


def _pdv_make_node(name, value, base_path):
    path = name if not base_path else f"{base_path}.{name}"
    try:
        info = pdv_info(value)
    except Exception:
        info = {'type': type(value).__name__, 'preview': repr(value)[:80]}
    node_type = _pdv_node_type(value, info)
    has_children = node_type in ('dict', 'list', 'tuple', 'set')
    if node_type == 'ndarray' and info.get('shape'):
        has_children = len(info.get('shape') or []) > 1
    preview = info.get('preview')
    if isinstance(value, PDVScript):
        preview = value.preview()
    elif node_type == 'dict':
        preview = preview or f"dict ({len(value)} items)"
    elif node_type in ('list', 'tuple', 'set'):
        preview = preview or f"{node_type} ({len(value)})"
    elif node_type == 'dataframe' and info.get('shape'):
        preview = preview or f"DataFrame ({info['shape'][0]} x {info['shape'][1]})"

    node = {
        'id': path,
        'key': str(name),
        'path': path,
        'type': node_type,
        'preview': preview,
        'hasChildren': has_children,
        'shape': info.get('shape'),
        'dtype': info.get('dtype'),
        'min': info.get('min'),
        'max': info.get('max'),
        'mean': info.get('mean'),
        'length': info.get('length'),
        'columns': info.get('columns'),
    }

    if isinstance(value, PDVScript):
        node['_file_path'] = value.file_path
        node['language'] = value.language
        node['actions'] = ['run', 'edit', 'reload', 'view_source']
        node['hasChildren'] = False

    return node


def _pdv_children_for(obj, base_path):
    children = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            children.append(_pdv_make_node(key, value, base_path))
    elif isinstance(obj, (list, tuple)):
        for idx, value in enumerate(obj):
            children.append(_pdv_make_node(str(idx), value, base_path))
    elif isinstance(obj, set):
        for idx, value in enumerate(sorted(list(obj), key=lambda x: repr(x))):
            children.append(_pdv_make_node(str(idx), value, base_path))
    return children


def pdv_tree_snapshot(path=""):
    """Return a JSON-serializable snapshot of the PDV tree at a path"""
    target = _pdv_resolve_tree_path(path)
    if target is None:
        return []
    return _pdv_children_for(target, path)


def pdv_register_script(parent_path, name, file_path, language='python'):
    """Attach a PDVScript to the tree at the given parent path"""
    parent = _pdv_resolve_tree_path(parent_path)
    if parent is None or not isinstance(parent, dict):
        return False
    script_name = name or os.path.splitext(os.path.basename(file_path))[0]
    parent[script_name] = PDVScript(file_path=file_path, language=language)
    return True

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
