# Module API

This page documents the extension points a module library uses to teach
PDV about its own types. The `pdv.handle` and `pdv.register_serializer`
hooks are bound onto the `pdv` app object at kernel startup; the dunder
protocol is purely class-side and does not depend on `import pdv`.

There are three extension points:

| Want to…                                            | Use                          |
|-----------------------------------------------------|------------------------------|
| React when a user double-clicks a node of your type | `pdv.handle` or `__pdv_handle__` |
| Persist instances of your type to disk              | `pdv.register_serializer` or the dunder protocol |
| Opt a class into PDV without importing `pdv`        | **Dunder protocol** (below)  |

**Which to use.** Reach for `pdv.register_serializer` / `@pdv.handle` when
you're wrapping a class you don't own (e.g. `scipy.sparse.csr_matrix`).
Reach for the dunder protocol when you're authoring the class yourself and
want a PyPI install to be the only thing a user needs to do — no
`import mylib` before opening their project. Registered hooks take
precedence over dunders when both exist for the same class, so the
dunder protocol composes safely: your own classes can self-register, and
anyone else can still override your defaults with explicit registration.

## `pdv.handle`

A decorator that registers a function as the double-click handler for a
particular class. When a user activates a tree node whose value is an
instance of the registered class (or any subclass), PDV invokes the
registered function with `(obj, path, pdv_tree)`.

```python
from mylib import Equilibrium

@pdv.handle(Equilibrium)
def show_equilibrium(obj, path, pdv_tree):
    obj.plot()
```

Handlers are resolved by walking the object's MRO, so a handler
registered on a base class covers every subclass.

::: pdv.modules.handle
    options:
      show_root_heading: true
      show_source: false

## `pdv.register_serializer`

Registers a save/load callback pair for a class so PDV can persist
instances without falling back to `pickle`. This is the only supported
way to save objects whose state lives outside Python — ctypes pointers,
Fortran library handles, GPU buffers, and so on.

```python
from mylib import MeshHandle

def save_mesh(mesh, path):
    mesh.write_hdf5(path)

def load_mesh(path):
    return MeshHandle.from_hdf5(path)

pdv.register_serializer(
    MeshHandle,
    format='mylib_mesh',
    extension='.h5',
    save=save_mesh,
    load=load_mesh,
)
```

The `format` string is written into the project's `tree-index.json` so
that the correct loader can be found when the project is re-opened.
It must be unique across the user's installed modules and must not
collide with any of PDV's builtin format names.

::: pdv.serializers.register
    options:
      show_root_heading: true
      show_source: false

### `SerializerEntry`

The internal record type returned by the registry lookups. Module authors
will usually not need to interact with this directly, but it is documented
here for completeness.

::: pdv.serializers.SerializerEntry
    options:
      show_root_heading: true
      show_source: false

## Dunder protocol

A class your package defines can opt into PDV by implementing dunder
methods directly on itself, with **zero `import pdv`** anywhere in your
package. Once the package is installed, PDV can save, load, preview,
double-click-dispatch, and digest instances of your class — even if the
user has not imported your module before opening their project. PDV
recovers the class at load time from the descriptor's `python_type`
field via `importlib.import_module`.

### The six methods

| Method                | Kind       | Required | Signature                                  | Purpose                                       |
|-----------------------|------------|----------|--------------------------------------------|-----------------------------------------------|
| `__pdv_format__`      | classmethod| yes (trio) | `() -> (format_name: str, extension: str)` | Names the on-disk format and file extension. |
| `__pdv_serialize__`   | instance   | yes (trio) | `(path: str) -> None`                      | Writes `self`'s state to `path`.             |
| `__pdv_deserialize__` | classmethod| yes (trio) | `(path: str) -> instance`                  | Reads the file back and returns a fresh instance. |
| `__pdv_preview__`     | instance   | optional   | `() -> str`                                | Short preview shown in the tree panel (≤ 100 chars). |
| `__pdv_handle__`      | instance   | optional   | `(path: str, pdv_tree) -> None`            | Invoked when the user double-clicks the node. |
| `__pdv_digest__`      | instance   | optional   | `() -> bytes`                              | Stable content digest used by autosave caching and tree checksums. |

The three "trio" methods (`__pdv_format__`, `__pdv_serialize__`,
`__pdv_deserialize__`) are required as a set: defining only one or two of
them is silently treated as "no dunder protocol" (the names may exist for
unrelated reasons), and PDV falls through to the next persistence path.
The three optional methods are independent — for example, a class can
define just `__pdv_handle__` to enable double-click handling while
relying on pickle for storage.

### Worked example

`mypkg/geqdsk.py`:

```python
class GEqdskData:
    """G-EQDSK equilibrium file, e.g. from a magnetic-equilibrium code."""

    def __init__(self, b0: float, *, raw: str = ""):
        self.b0 = b0
        self.raw = raw

    # ------------------------------------------------------------------ trio
    @classmethod
    def __pdv_format__(cls):
        return ("geqdsk", ".geqdsk")

    def __pdv_serialize__(self, path):
        with open(path, "w") as fh:
            fh.write(f"b0={self.b0}\n")
            fh.write(self.raw)

    @classmethod
    def __pdv_deserialize__(cls, path):
        with open(path) as fh:
            first = fh.readline().strip()
            rest = fh.read()
        b0 = float(first.split("=", 1)[1])
        return cls(b0, raw=rest)

    # -------------------------------------------------------------- optional
    def __pdv_preview__(self):
        return f"G-EQDSK(B0={self.b0:.2f})"

    def __pdv_handle__(self, path, pdv_tree):
        # Could open a plot, dump to console, etc.
        print(f"[geqdsk] {path}: B0 = {self.b0}")

    def __pdv_digest__(self):
        # Whatever bytes uniquely identify the equilibrium.
        return f"{self.b0}|{self.raw}".encode("utf-8")
```

User session:

```python
from mypkg.geqdsk import GEqdskData

pdv_tree["g"] = GEqdskData(b0=2.1, raw="…")
# Tree shows: g    "G-EQDSK(B0=2.10)"
# File → Save Project writes <save>/tree/<uuid>/g.geqdsk

# Later, in a fresh kernel — no need to import mypkg first:
# File → Open Project reads tree-index.json, sees
# storage.format == "geqdsk" and metadata.python_type ==
# "mypkg.geqdsk.GEqdskData", imports the module via
# importlib.import_module, and calls GEqdskData.__pdv_deserialize__.
```

The on-disk descriptor recorded in `tree-index.json` looks like:

```json
{
  "type": "unknown",
  "storage": {
    "backend": "local_file",
    "uuid": "abc123…",
    "filename": "g.geqdsk",
    "format": "geqdsk"
  },
  "metadata": {
    "preview": "G-EQDSK(B0=2.10)",
    "python_type": "mypkg.geqdsk.GEqdskData",
    "serializer": "dunder:mypkg.geqdsk.GEqdskData"
  }
}
```

### Precedence

When both a registered hook and a dunder are present for the same class,
the registered hook wins. This lets a downstream user of your package
override your defaults with explicit `register_serializer` /
`@pdv.handle` calls.

| Behavior         | Highest precedence                | Fallback           |
|------------------|-----------------------------------|--------------------|
| Save format      | `pdv.register_serializer`         | `__pdv_format__`   |
| Load format      | `pdv.register_serializer`         | `__pdv_deserialize__` (resolved via `metadata.python_type`) |
| Tree preview     | `pdv.register_serializer(preview=…)` | `__pdv_preview__`, then `value.preview()` |
| Double-click     | `@pdv.handle`                     | `__pdv_handle__`   |
| Checksum digest  | (no registered hook today)        | `__pdv_digest__`, then `repr(value)` |

Builtin kind dispatch (`ndarray`, `script`, `markdown`, …) and the
xarray special-case bypass run **before** any custom hook. Trusted-pickle
is the absolute fallback.

### Format-name rules

`__pdv_format__` must return `(format_name, extension)` where:

* `format_name` is a non-empty string that does **not** collide with a
  PDV builtin (`npy`, `json`, `txt`, `pickle`, `py_script`, `markdown`,
  `inline`, `gui_json`, `module_meta`, `namelist`, `py_lib`, `bin`,
  `none`).
* `format_name` must not collide with a `pdv.register_serializer` entry
  for a *different* class; if your class registers the same format both
  ways (dunder and `register_serializer`), the registered entry takes
  precedence and no collision is raised.
* `extension` may include or omit a leading dot; PDV normalizes it.

Violations raise `PDVSerializationError` at the time of the first save
attempt for that class.

### Load-time class recovery

On project load, the descriptor's `metadata.python_type` is fed to
`importlib.import_module` plus an attribute walk to recover the class.
That means:

* The defining package must be installed in the kernel's Python
  environment.
* The class's fully-qualified name must not have moved since save; if
  you rename `mypkg.geqdsk.GEqdskData → mypkg.geqdsk.GEqdsk`, old
  projects will fail to load until either the alias is restored or the
  user resaves the project under the new name.

If the import fails or the class no longer implements
`__pdv_deserialize__`, PDV raises a `PDVSerializationError` naming the
`python_type` so the user knows what to install.

### Public helpers

::: pdv.serializers.find_for_value_dunder
    options:
      show_root_heading: true
      show_source: false

::: pdv.serializers.find_for_format_dunder
    options:
      show_root_heading: true
      show_source: false

::: pdv.serializers.DunderEntry
    options:
      show_root_heading: true
      show_source: false
