# PDV Rundown & Ising Model Test Plan

A comprehensive summary of what PDV is, what it can do, and a plan for an Ising model simulation that exercises the core features.

---

## Part 1 — What PDV Is

**Physics Data Viewer (PDV)** is an Electron desktop application for computational and experimental physics analysis. Think of it as a spiritual successor to Jupyter notebooks, but with a key differentiator: **the Tree**.

### The Core Idea

Instead of a linear chain of notebook cells, PDV gives you:

1. **A tabbed code editor** (Monaco / VS Code-style) — write and run Python commands
2. **An execution console** — see output, plots, errors in real time
3. **The Tree** — a persistent, typed, hierarchical data structure that lives in the kernel

The Tree is the central concept. It's a live Python dict (`pdv_tree`) that you interact with from code, but that also has a visual panel in the UI for browsing, clicking, and inspecting. When you save a project, the Tree is serialized. When you reopen it, everything is back — your data, your scripts, your notes, your structure.

### Architecture (Three-Process Model)

```
Renderer (React UI)  ──window.pdv──►  Main Process (Node.js)  ──ZeroMQ──►  Kernel (Python + ipykernel)
```

- **Renderer**: The UI. Tree panel, code editor, console, namespace view. No direct filesystem access.
- **Main Process**: Manages kernel lifecycle, IPC, filesystem, config. All communication between renderer and kernel goes through here.
- **Kernel**: Runs `ipykernel` + `pdv-python`. Owns the `pdv_tree`, executes user code, handles the PDV comm protocol.

The kernel communicates with the main process through a custom Jupyter comm channel (`pdv.kernel`), not just `execute_request`. This means structured operations (tree queries, project save/load, namespace inspection) happen over typed protocol messages. There's also a dedicated **query channel** (ZeroMQ REQ/REP) so tree browsing works even while code is executing.

---

## Part 2 — What PDV Can Do (Feature Inventory)

### 2.1 The Tree (`pdv_tree`)

The Tree is a `dict` subclass with superpowers:

- **Dot-path notation**: `pdv_tree["results.fit.amplitude"]` navigates nested dicts automatically
- **Automatic notifications**: Setting/deleting values emits `pdv.tree.changed` to the UI — the tree panel updates live
- **Lazy loading**: On project load, data stays on disk until accessed. Metadata loads instantly.
- **Protected namespace**: `pdv_tree` and `pdv` cannot be overwritten by user code

**Supported node types**:

| Type | Storage | Description |
|------|---------|-------------|
| `folder` | In-memory | `PDVTree` sub-dict (container) |
| `ndarray` | `.npy` | NumPy arrays |
| `dataframe` | `.parquet` | Pandas DataFrames |
| `series` | `.parquet` | Pandas Series |
| `scalar` | Inline JSON | int, float, bool, None |
| `text` | `.txt` or inline | Strings |
| `mapping` | Inline JSON | Plain dicts |
| `sequence` | Inline JSON | Lists, tuples |
| `script` | `.py` file | PDVScript — reusable analysis code |
| `markdown` | `.md` file | PDVNote — notes with LaTeX math |
| `module` | Metadata | PDVModule — packaged analysis workflow |
| `gui` | `.gui.json` | Declarative GUI definition |
| `namelist` | Namelist file | Fortran/TOML simulation config |
| `lib` | `.py` file | Importable Python library |
| `unknown` | `.pickle` or custom | Anything else (custom serializer or pickle) |

### 2.2 Scripts (`PDVScript`)

Scripts are `.py` files stored as tree nodes. Every script has one function:

```python
def run(pdv_tree: dict, temperature: float = 2.27, n_steps: int = 10000) -> dict:
    # pdv_tree is injected automatically — never pass it yourself
    data = pdv_tree["lattice"]
    # ... do analysis ...
    pdv_tree["results.magnetization"] = mag
    return {"status": "ok"}
```

- Created via right-click context menu in the tree: **New Script**
- Parameters after `pdv_tree` become UI fields in a **Script Dialog** (with type hints for validation)
- Run from the tree panel (right-click → Run) or from code: `pdv_tree["scripts.my_script"].run(temperature=2.5)`
- Output streams to the console in real time
- After execution, the tree auto-refreshes to show new/changed nodes

### 2.3 Notes (`PDVNote`)

Markdown notes stored as tree nodes. The **Write Tab** (alongside the Code Tab) provides:

- Monaco editor with **inline KaTeX math preview** (`$...$` and `$$...$$`)
- **Edit/Read toggle**: switch between source editing and fully rendered markdown
- **Auto-save** with 5-second debounce
- Multiple notes open in tabs simultaneously

Great for documenting theory, analysis steps, or results alongside the data.

### 2.4 Project Save/Load

A PDV project is a directory:

```
my-project/
    project.json          ← project manifest
    tree-index.json       ← full tree structure (node metadata)
    code-cells.json       ← code editor tab state
    tree/
        data/             ← .npy, .parquet, .json files
        scripts/          ← .py script files
    modules/              ← installed module copies
```

- **Save**: Serializes the entire tree + code tabs + module state
- **Load**: Rebuilds tree from `tree-index.json` with lazy loading
- Portable: zip and share with colleagues

### 2.5 Code Editor (Code Cell)

- Monaco editor (VS Code engine) with Python syntax highlighting
- **Jupyter-powered autocomplete** and **hover documentation** from the live kernel
- Multi-tab workflow (Cmd+T new tab, Cmd+W close)
- Execute with Cmd+Enter — output streams to the console
- Tab state saved with the project

### 2.6 Console

- Chronological log of all execution output
- Supports: stdout/stderr, inline plots (matplotlib), error tracebacks, rich output (HTML, LaTeX)
- Ephemeral — not saved with the project (by design)

### 2.7 Namespace Inspector

- Live view of all kernel variables (excluding PDV internals)
- Shows type, shape, preview for each variable
- Lazy child inspection — expand complex objects to drill into attributes
- Works even during code execution (via the query channel)

### 2.8 Modules

Modules are packaged, reusable analysis workflows. A module contains:

- **Scripts** — action scripts (solve, plot, analyze)
- **Lib** — shared Python code importable by scripts
- **GUI** — declarative UI (inputs, buttons, tabs, namelists)
- **Namelists** — structured config file editors (Fortran/TOML)

The included **N-Pendulum** example module demonstrates all of this. Modules can be:
- Installed globally from local directories or GitHub
- Imported into a project with an alias
- Authored in-session and exported

Module GUIs open in a separate window with controls (sliders, dropdowns, checkboxes, file pickers) wired to script parameters.

### 2.9 Custom Type Handlers

Modules can register custom Python classes with double-click handlers:

```python
from pdv_kernel import handle

class MyResult:
    def __init__(self, data):
        self.data = data

@handle(MyResult)
def plot_my_result(obj, path, pdv_tree):
    import matplotlib.pyplot as plt
    plt.plot(obj.data)
    plt.show()
```

Double-clicking a tree node containing `MyResult` triggers the handler and shows a plot.

### 2.10 Custom Serializers

You can register save/load callbacks for custom types:

```python
pdv.register_serializer(MyClass, format="my_fmt", extension=".h5", save=..., load=...)
```

This lets custom objects survive project save/load.

### 2.11 Environment Management

- Detects conda, venv, pyenv, system Python environments
- Installs `pdv-python` automatically on first launch
- Per-project `uv`-managed environments (opt-in) — `pyproject.toml` + `uv.lock` travel with the project
- Version compatibility checks between app and kernel

### 2.12 Themes and Customization

- Built-in light/dark themes
- Custom theme files in `~/.PDV/themes/`
- Configurable fonts, keyboard shortcuts
- Customizable key bindings for renderer actions

---

## Part 3 — Ising Model Test Plan

### Goal

Build an Ising model simulation inside PDV that exercises as many core features as possible. This is a test run to probe what works well and what doesn't.

### The Physics

The 2D Ising model on an L×L square lattice with periodic boundary conditions. Each site has spin $s_i \in \{-1, +1\}$. The Hamiltonian is:

$$H = -J \sum_{\langle i,j \rangle} s_i s_j$$

We'll use the Metropolis-Hastings algorithm (single spin flip) and measure:
- Magnetization: $M = \frac{1}{N} \sum_i s_i$
- Energy: $E = H / N$
- Specific heat: $C_v = \frac{\langle E^2 \rangle - \langle E \rangle^2}{T^2}$
- Magnetic susceptibility: $\chi = \frac{\langle M^2 \rangle - \langle M \rangle^2}{T}$

The critical temperature is $T_c = \frac{2J}{\ln(1+\sqrt{2})} \approx 2.269$.

### Features Exercised

| PDV Feature | How It's Used |
|-------------|---------------|
| **Tree (folders, ndarrays, scalars)** | Lattice stored as ndarray, results organized in tree hierarchy |
| **Scripts (PDVScript)** | Separate scripts for: initialize, simulate, measure, sweep, plot |
| **Script parameters** | Temperature, lattice size, MC steps, etc. as typed params |
| **Script Dialog** | Running scripts from the tree with parameter entry |
| **Notes (PDVNote)** | Theory note with LaTeX math for the Ising model |
| **Code Cell** | Ad hoc exploration: inspect lattice, quick plots, test snippets |
| **Console output** | Progress output from MC simulations |
| **Namespace Inspector** | Inspect intermediate variables during development |
| **Inline plots** | Matplotlib plots of magnetization, phase transition, lattice snapshots |
| **Project save/load** | Save simulation state, close, reopen, continue |
| **Lazy loading** | Large sweep data loads on-demand when browsing the tree |
| **DataFrames** | Temperature sweep results as pandas DataFrame |
| **Multiple data types** | ndarray (lattice, timeseries), scalar (Tc, final M), DataFrame (sweep), text (metadata) |

### Proposed Tree Structure

```
ising/
├── config                    ← scalar/mapping: simulation parameters (L, J, etc.)
├── theory_notes              ← PDVNote: markdown with LaTeX Ising model theory
├── lattice/
│   ├── initial               ← ndarray: L×L initial spin configuration
│   ├── equilibrated          ← ndarray: L×L after equilibration
│   └── final                 ← ndarray: L×L after measurement
├── scripts/
│   ├── initialize            ← PDVScript: create random or ordered lattice
│   ├── simulate              ← PDVScript: run Metropolis MC at given T
│   ├── measure               ← PDVScript: compute observables from current lattice
│   ├── sweep                 ← PDVScript: temperature sweep across T range
│   └── plot_results          ← PDVScript: generate publication-quality plots
├── results/
│   ├── single_run/
│   │   ├── magnetization     ← ndarray: M vs MC step timeseries
│   │   ├── energy            ← ndarray: E vs MC step timeseries
│   │   ├── final_M           ← scalar: final magnetization
│   │   └── final_E           ← scalar: final energy per spin
│   └── sweep/
│       ├── temperatures      ← ndarray: array of T values
│       ├── magnetization     ← ndarray: |M|(T) for each T
│       ├── energy            ← ndarray: E(T) for each T
│       ├── specific_heat     ← ndarray: Cv(T)
│       ├── susceptibility    ← ndarray: chi(T)
│       └── summary           ← DataFrame: all observables in one table
└── plots/
    ├── lattice_snapshot      ← (generated by plot script, shown in console)
    ├── phase_transition      ← (magnetization vs temperature curve)
    └── thermodynamic_curves  ← (Cv and chi vs T)
```

### Script Designs

#### 1. `initialize.py`
```
Parameters: L (int, default=32), initial_state (str: "random"/"ordered", default="random")
Action: Create L×L spin lattice, store in pdv_tree["ising.lattice.initial"]
```

#### 2. `simulate.py`
```
Parameters: temperature (float, default=2.27), n_equilibrate (int, default=5000),
            n_measure (int, default=10000), measure_interval (int, default=10)
Action: Run Metropolis MC, store timeseries + final lattice in results
Console: Print progress every 1000 steps
```

#### 3. `measure.py`
```
Parameters: (none beyond pdv_tree)
Action: Compute M, E, Cv, chi from stored timeseries, store as scalars
```

#### 4. `sweep.py`
```
Parameters: T_min (float, default=1.0), T_max (float, default=4.0), n_temps (int, default=20),
            n_equilibrate (int, default=5000), n_measure (int, default=10000)
Action: Loop over temperatures, run full simulation at each, collect observables into arrays + DataFrame
Console: Print progress for each temperature point
```

#### 5. `plot_results.py`
```
Parameters: plot_type (str: "lattice"/"phase"/"thermo", default="phase")
Action: Generate matplotlib figure for the chosen plot type
Console: Inline plot display
```

### Theory Note Content

A markdown note covering:
- The Hamiltonian and partition function
- Metropolis algorithm pseudocode
- Critical temperature derivation (Onsager's exact solution reference)
- Expected behavior: spontaneous magnetization below $T_c$, divergent susceptibility at $T_c$

All with LaTeX math ($H = -J\sum ...$, $T_c = 2J / \ln(1+\sqrt{2})$, etc.) to test the KaTeX rendering.

### Workflow Sequence (Test Steps)

1. **New Project** → Create project "Ising Model Test"
2. **Code Cell**: Quick test — `import numpy as np; print(np.__version__)` — verify kernel works
3. **Create folder structure**: `pdv_tree["ising"] = {}` etc. from code cell
4. **Create theory note**: Right-click ising → New Note → Write Ising theory with LaTeX
5. **Create scripts**: Right-click ising.scripts → New Script → write each script
6. **Run initialize**: From tree, right-click → Run, set L=32
7. **Inspect**: Click on `ising.lattice.initial` in tree — see ndarray metadata. Check Namespace Inspector.
8. **Run simulate**: Set T=2.27 (critical), watch console output
9. **Run plot_results**: plot_type="lattice" — see inline lattice heatmap
10. **Run sweep**: T_min=1.0, T_max=4.0, n_temps=20 — watch console progress
11. **Run plot_results**: plot_type="phase" — see magnetization vs T curve
12. **Save project**: Cmd+S → choose location
13. **Close and reopen**: Verify everything is back — tree structure, scripts, note, data
14. **Browse lazy data**: Click on sweep arrays — verify lazy loading works
15. **Edit a script**: Change a parameter, re-run — see updated results
16. **Ad hoc exploration**: In code cell, do `pdv_tree["ising.results.sweep.summary"]` to inspect the DataFrame

### What to Watch For (Test Targets)

- [ ] Tree panel updates live as scripts write data
- [ ] Script Dialog correctly shows typed parameters (int, float, str)
- [ ] Console streams progress output in real time during long simulations
- [ ] Inline matplotlib plots render in the console
- [ ] Large arrays (sweep data) don't lag the tree panel (lazy loading)
- [ ] Project save captures everything (scripts, notes, arrays, DataFrames, scalars)
- [ ] Project load restores correctly, lazy-loads data on access
- [ ] Note LaTeX math renders correctly in Edit and Read modes
- [ ] Namespace Inspector shows simulation variables during/after execution
- [ ] Code cell autocomplete works for `pdv_tree`, numpy, etc.
- [ ] Multiple code cell tabs work (one for exploration, one for scratch)
- [ ] Error handling: what happens if you run simulate before initialize?

### Dependencies Needed

All standard scientific Python — should be pre-installed in most environments:
- `numpy`
- `matplotlib`
- `pandas` (for the sweep summary DataFrame)

No exotic dependencies, so this tests the "vanilla physics workflow" without module/environment complications.

---

## Part 4 — Key Things Learned

### Architecture Insights
- The three-process model is strict. The renderer never touches the filesystem. Everything routes through `window.pdv.*`.
- `ipc.ts` is the single source of truth for all IPC channels. Don't define channel strings elsewhere.
- The kernel owns the Tree. The main process never caches or reconstructs tree state.
- There's a dedicated query channel (ZeroMQ REQ/REP) so tree browsing and namespace inspection work during code execution.

### The Tree is Everything
- `PDVTree` is a `dict` subclass — natural Python usage
- Dot-path notation is convenient: `pdv_tree["a.b.c"]` auto-traverses
- Change notifications are debounced (100ms) — bulk operations don't flood the UI
- Nested dict limitation: mutations on sub-dicts accessed via `pdv_tree["parent"]` are silent. Always use root-level dot-path access for notifications to fire.

### Scripts Follow a Strict Pattern
- One `run()` function per script
- First param is always `pdv_tree: dict` (injected, never user-supplied)
- All other params become the UI dialog fields
- Return must be `dict` or `None`
- Scripts are loaded fresh each time (no import cache)

### Modules Are Powerful but Complex
- v4 schema only (legacy v1-v3 removed)
- `module-index.json` required for import
- Libs get hot-reloaded before each script run (`pdv.module.reload_libs`)
- GUI definitions are declarative JSON with tabs, groups, rows, columns
- Module GUIs open in separate Electron windows

### Save/Load is Kernel-Authoritative
- The kernel serializes the tree to `tree-index.json`
- Data files go to `tree/` subdirectory with format-appropriate extensions
- Lazy loading means large projects open fast
- Console history is ephemeral (not saved)
- Code cell tabs ARE saved

### What's Not There Yet
- User-facing docs are mostly stubs (`<!-- TODO -->`)
- No automated renderer tests (manual smoke test only)
- Julia support is deferred to beta3
- Remote execution (SSH) and AI agent integration (MCP server) are planned for beta2
- No crash recovery / autosave yet
- No command palette / search yet
