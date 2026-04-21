# Notes & Projects

## Notes

Notes are markdown documents attached to the Tree as `PDVNote` nodes. They're useful for documenting analysis steps, recording assumptions, or writing up results alongside the data they describe.

### Creating a note

Right-click any node in the Tree panel and select **Create Note**. Give it a name — PDV creates a `.md` file on disk and opens it in the **Write** pane.

### Editing

Switch to the Write pane using the **Code / Write** toggle at the top of the center column. Notes open in tabs, just like code cells.

The editor has two modes, toggled with the **Edit / Read** buttons:

- **Edit** — raw markdown in a Monaco editor.
- **Read** — rendered output with formatted headings, lists, code blocks, and math.

Notes auto-save five seconds after your last keystroke. A dot (●) on the tab indicates unsaved changes.

### Math support

Notes support LaTeX math via KaTeX:

- **Inline math:** `$E = mc^2$` renders as $E = mc^2$
- **Display math:**
  ```
  $$
  \nabla \cdot \mathbf{B} = 0
  $$
  ```

### Notes in the Tree

Because notes are Tree nodes, they're saved and restored with the project. You can organise them in the hierarchy alongside the data they describe:

```
experiment/
  raw_data = [...]
  notes.method         ← PDVNote
  results/
    fit_coeffs = [...]
    notes.interpretation ← PDVNote
```

---

## Projects

A PDV project is a directory on disk that stores the complete state of an analysis session: tree data, code cell contents, notes, scripts, and metadata.

### Creating a project

Click **New Python Project** on the Welcome screen (or **File → New Project**). PDV starts a kernel and gives you an empty workspace. At this point the project exists only in memory — nothing is on disk yet until you save.

### Saving

**File → Save** (++cmd+s++) or `pdv.save()` in a code cell. The first save prompts you for a directory and project name. Subsequent saves overwrite in place.

A saved project directory contains:

| File | Contents |
|---|---|
| `project.json` | Metadata: language, interpreter path, PDV version, timestamps |
| `tree-index.json` | Tree structure and serialized scalar values |
| `code-cells.json` | Editor tab contents and order |
| `scripts/` | One `.py` file per `PDVScript` node |
| `notes/` | One `.md` file per `PDVNote` node |
| `data/` | Binary data files (arrays, DataFrames) referenced by the tree index |

!!! tip "What gets saved"
    Everything in the Tree is saved. Kernel namespace variables that are **not** in the Tree are ephemeral — they exist for the current session only. If you want a value to survive across sessions, put it in `pdv_tree`.

### Opening a project

**File → Open Project** (or click a recent project on the Welcome screen). PDV reads the project directory, starts a kernel with the saved interpreter, and reconstructs the tree. Code cells are restored; the console starts empty (execution history is not persisted).

### The working directory

PDV gives each project a **working directory** for on-disk scratch files. Access it from code as `pdv.working_dir`:

```python
import numpy as np
data = np.loadtxt(pdv.working_dir / "data.csv")
```

`pdv.working_dir` is a `pathlib.Path`. It points at the project directory after the first save, or a temporary directory for unsaved projects.

!!! note "Your kernel's `cwd` is not the working directory"
    PDV does **not** change `os.getcwd()` — it stays at your home directory. A bare `open("data.csv")` resolves against `~`, not against the project. Always use `pdv.working_dir` for project-relative paths.

### Persistence model

The Tree is the **only** persistent surface in PDV:

- Values in `pdv_tree` → saved with the project.
- Files you manually place in `pdv.working_dir` → **not** saved unless attached to the tree as a `PDVFile` node.
- Kernel namespace variables → lost when the kernel stops.

If you want a file to be part of the project, attach it to the tree:

```python
from pdv.tree import PDVFile

pdv_tree["data.input_deck"] = PDVFile("input.dat")
```

### Version pinning

During the `0.x` releases, the `pdv-python` version must match the app version exactly. When you upgrade PDV, re-run the install step for your environment (see [Installation § Troubleshooting](../getting-started/installation.md#troubleshooting)). Version `1.0` will introduce a more flexible compatibility policy with backwards-compatible kernel updates.
