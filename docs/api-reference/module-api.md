# Module API

This page documents the extension points a module library uses to teach
PDV about its own types. Everything here is bound onto the `pdv` app
object at kernel startup — regular users will not need it.

There are two extension points:

| Want to…                                            | Use                          |
|-----------------------------------------------------|------------------------------|
| React when a user double-clicks a node of your type | `pdv.handle`                 |
| Persist instances of your type to disk              | `pdv.register_serializer`    |

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
