# Projects

<!-- TODO -->

## The working directory

PDV keeps all of a session's on-disk content (scripts, files, notes) under a
single working directory. This is a per-session temp directory until you save
the project, and it stays stable for the lifetime of the kernel.

The kernel's own current working directory (`os.getcwd()`) defaults to your
home directory and PDV will **not** change it behind your back. That means a
plain `np.loadtxt("data.csv")` in a code cell or script resolves against
`~`, not against your project. To load a file that lives alongside your
project, use `pdv.working_dir`:

```python
import numpy as np
data = np.loadtxt(pdv.working_dir / "data.csv")
```

`pdv.working_dir` is a `pathlib.Path` pointing at the current session's
working directory.

**Persistence.** The tree is the only persistent surface in PDV. Files you
drop under `pdv.working_dir` directly are scratch — they are not copied into
the project save directory when you save. To make a file part of the saved
project, attach it to the tree as a `PDVFile` node. Everything in the tree
is serialized on save; everything else is not.
