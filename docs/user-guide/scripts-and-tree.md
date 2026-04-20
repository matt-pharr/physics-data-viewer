# Scripts & the Tree

The **Tree** is PDV's persistent data model — a hierarchical dictionary that lives in the kernel as `pdv_tree`. **Scripts** are reusable Python functions attached to the Tree that can be run with parameters. Together, they form the core of a PDV project.

---

## The Tree

### What it is

`pdv_tree` is a nested dictionary that you interact with like any Python dict, with one important difference: everything you store in it is saved with your project and restored when you reopen it. Plain kernel variables are ephemeral; the Tree is not.

```python
# Store data — persists across sessions
pdv_tree["experiment.temperature"] = np.array([300, 350, 400, 450])
pdv_tree["experiment.pressure"]    = np.array([1.0, 1.2, 1.5, 1.9])

# Read it back
T = pdv_tree["experiment.temperature"]
```

### Dot-path keys

Dots in key strings create nested structure automatically:

```python
pdv_tree["results.fit.slope"]     = 0.42
pdv_tree["results.fit.intercept"] = 1.1
```

This creates the hierarchy:

```
results/
  fit/
    slope = 0.42
    intercept = 1.1
```

You can also use standard nested dict syntax: `pdv_tree["results"]["fit"]["slope"]`.

### What you can store

The Tree accepts any Python value that can be serialized:

- Scalars (`int`, `float`, `str`, `bool`, `complex`)
- NumPy arrays
- Pandas DataFrames and Series
- Lists and dicts (nested arbitrarily)
- PDV node types: `PDVScript`, `PDVNote`, `PDVFile`, `PDVLib`

Large arrays and DataFrames are handled efficiently — PDV uses format-appropriate serialization (e.g. `.npy` for arrays, `.parquet` for DataFrames) rather than pickling everything.

### The Tree panel

The Tree panel in the sidebar is a live view of `pdv_tree`. It updates automatically whenever your code modifies the tree. You can:

- **Expand / collapse** nodes to browse the hierarchy
- **Right-click** a node for actions: Run (scripts), Edit, Delete, Print, Copy Path
- **Copy Path** pastes the Python accessor string (e.g. `pdv_tree["results"]["fit"]`) into your clipboard

---

## Scripts

### What a script is

A PDV script is a Python file attached to the Tree as a `PDVScript` node. Every script defines a `run` function:

```python
def run(pdv_tree, amplitude=1.0, frequency=1.0):
    """Generate a sine wave and store it in the tree."""
    import numpy as np

    x = np.linspace(0, 2 * np.pi, 500)
    pdv_tree["output.x"] = x
    pdv_tree["output.y"] = amplitude * np.sin(frequency * x)
```

- The first argument is always `pdv_tree` — PDV injects it automatically.
- Additional arguments become **parameters** that the user can fill in at run time.
- Type annotations and defaults are respected: `amplitude: float = 1.0` renders as a numeric input with default `1.0` in the run dialog.

### Creating a script

Right-click any node in the Tree panel and select **Create Script**. Give it a name — PDV creates the file on disk and opens it in your system editor (or the code editor, depending on your settings). Write a `run` function, save, and the script is ready.

### Running a script

There are two ways:

1. **Right-click → Run** — opens a dialog showing the script's parameters. Fill in values (or keep the defaults) and click **Run**.
2. **Right-click → Run with Defaults** — executes immediately using default parameter values, skipping the dialog.

Output from the script (print statements, plots, errors) appears in the console, just like code cell execution. If the script modifies `pdv_tree`, the Tree panel refreshes automatically.

### Scripts vs. code cells

| | Code cells | Scripts |
|---|---|---|
| **Purpose** | Ad-hoc exploration, quick calculations | Repeatable analyses with parameters |
| **Location** | Editor tabs (not in the Tree) | Nodes in the Tree |
| **Saved with project?** | Yes (editor state) | Yes (as files) |
| **Parameterised?** | No | Yes — `run()` signature defines the parameter UI |
| **How to run** | ++cmd+enter++ in the editor | Right-click → Run in the Tree panel |

Use code cells for exploration, then promote useful workflows to scripts when you want them to be reusable and parameterised.

---

## The `pdv` object

The `pdv` object is always available in code cells and scripts. It provides utilities that sit outside the Tree:

| Attribute / Method | Description |
|---|---|
| `pdv.working_dir` | `pathlib.Path` pointing at the project's working directory. Use it to reference data files: `np.loadtxt(pdv.working_dir / "data.csv")` |
| `pdv.save()` | Trigger a project save programmatically (same as ++cmd+s++). |
| `pdv.help()` | Print an overview of PDV's API. Pass a topic string for details: `pdv.help("pdv_tree")`. |

!!! warning "Protected names"
    `pdv` and `pdv_tree` cannot be reassigned. Writing `pdv = 5` raises a `PDVProtectedNameError`. This prevents accidental loss of the app object or the project data.

---

## Worked example

A small but complete workflow: load experimental data, fit a curve, and store the results.

```python
# --- In a code cell: explore the data ---
import numpy as np

raw = np.loadtxt(pdv.working_dir / "measurement.csv", delimiter=",")
pdv_tree["experiment.raw"] = raw
print(raw.shape)  # (100, 2)
```

```python
# --- Create a script node called "fit_curve" and write: ---
def run(pdv_tree, degree: int = 2):
    """Polynomial fit to the raw measurement data."""
    import numpy as np

    raw = pdv_tree["experiment.raw"]
    x, y = raw[:, 0], raw[:, 1]

    coeffs = np.polyfit(x, y, degree)
    pdv_tree["experiment.fit_coeffs"] = coeffs
    pdv_tree["experiment.fit_curve"]  = np.polyval(coeffs, x)
```

Run the script from the Tree panel — pick `degree = 3` in the dialog — and the fitted curve and coefficients land in the Tree, saved with the project.
