# Tree Node Types

The tree stores two kinds of values:

1. **Plain Python data** — numbers, strings, lists, NumPy arrays, pandas
   DataFrames, and nested `dict`s. PDV serializes these directly using its
   built-in type detection.
2. **Typed file nodes** — instances of the classes documented below. Each
   one wraps a file on disk and carries enough metadata for PDV to render,
   edit, or execute it from the UI.

Each file node is keyed by a `uuid` (its storage directory is
`tree/<uuid>/` under the working dir) and a `filename`. You rarely construct
these by hand — `pdv.add_file(...)` and the UI allocate the UUID and copy the
file for you — but the constructor signatures are:

```python
from pdv import PDVScript, PDVNote

PDVScript(uuid, filename, language='python', doc=None, module_id='', source_rel_path=None)
PDVNote(uuid, filename, title=None)
```

All node types are importable from the top-level `pdv` package.
`PDVFile` is the base class for every file-backed node — its `uuid`,
`filename`, `source_rel_path`, and `resolve_path()` members are inherited by
all of the subclasses below.

---

::: pdv.tree.PDVFile

---

::: pdv.tree.PDVScript
    options:
      inherited_members: false

---

::: pdv.tree.PDVNote
    options:
      inherited_members: false

---

::: pdv.tree.PDVGui
    options:
      inherited_members: false

---

::: pdv.tree.PDVNamelist
    options:
      inherited_members: false

---

::: pdv.tree.PDVLib
    options:
      inherited_members: false

---

A `PDVModule` is itself a subclass of `PDVTree`, so it supports all the
same dict-like operations. It represents a self-contained module package
mounted at a tree path.

::: pdv.tree.PDVModule
    options:
      inherited_members: false
