# User Guide

This guide walks through PDV's interface and core workflow. If you haven't installed the app yet, start with the [Installation](../getting-started/installation.md) page.

---

## The interface

PDV's window is divided into three zones:

```
┌──────────────────────────────────────────────────────┐
│  Activity Bar  │          Center Column               │
│  ───────────── │  ┌ Pane switcher (Code / Write) ──┐ │
│  Tree          │  │ Console (output, plots, errors) │ │
│  Namespace     │  │─────────────────────────────────│ │
│  Module GUIs   │  │ Code editor (tabbed)            │ │
│  ───────────── │  │        — or —                   │ │
│  Settings      │  │ Write tab (markdown notes)      │ │
│                │  └─────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│  Status bar: kernel state · runtime · exec time       │
└──────────────────────────────────────────────────────┘
```

### Activity Bar

The vertical strip on the far left. Click an icon to toggle the corresponding sidebar panel:

- **Tree** — the project data hierarchy. This is where your scripts, notes, and results live.
- **Namespace** — a live inspector for kernel variables (arrays, DataFrames, scalars, etc.). Searchable, sortable, and expandable for nested objects.
- **Module GUIs** — one icon per imported module that ships a GUI. These appear dynamically when you import a module.
- **Settings** (bottom) — global app preferences: theme, font, editor behaviour.

### Center Column

The main working area has two panes, toggled by the **Code / Write** switcher at the top:

**Code pane**

- **Console** (top half) — a chronological log of everything you run: executed code, stdout/stderr, inline plots, return values, errors with tracebacks, and execution time.
- **Code editor** (bottom half) — a tabbed Monaco editor for Python (or Julia). Each tab is a scratch code cell. Keyboard shortcuts: ++cmd+enter++ to execute, ++cmd+l++ to clear, ++cmd+w++ to close a tab.

**Write pane**

- A tabbed markdown editor for [notes](notes-and-projects.md#notes). Toggle between **Edit** (raw markdown) and **Read** (rendered output with KaTeX math). Notes auto-save five seconds after your last keystroke.

### Status Bar

The bottom strip shows: kernel busy/idle indicator, active Python runtime and path, project directory, last execution duration, and save/load progress.

---

## Quick-start workflow

Here's the shortest path from launch to a saved project:

### 1. Create a project

Open PDV and click **New Python Project**. Select a Python environment (see [Installation § Pick a Python environment](../getting-started/installation.md#3-pick-a-python-environment) if this is your first time). The app starts a kernel and drops you into an empty project.

### 2. Run some code

Type into the code editor and press ++cmd+enter++:

```python
import numpy as np

x = np.linspace(0, 2 * np.pi, 200)
pdv_tree["demo.x"] = x
pdv_tree["demo.sin_x"] = np.sin(x)
```

The Tree panel on the left updates immediately — expand **demo** to see `x` and `sin_x`. Any value you assign to `pdv_tree` is persistent project data; plain variables like `x` live only in the kernel namespace.

### 3. Plot something

```python
import matplotlib.pyplot as plt

plt.plot(pdv_tree["demo.x"], pdv_tree["demo.sin_x"])
plt.title("sin(x)")
plt.show()
```

The plot appears inline in the console.

### 4. Save

Press ++cmd+s++ (or run `pdv.save()` in a code cell). Pick a directory and project name. PDV writes the full project state — tree data, code cells, notes, scripts — to that directory. Close and reopen it later with **Open Project** and everything is restored.

---

## Next steps

- [Scripts & the Tree](scripts-and-tree.md) — learn about PDV's persistent data model and reusable scripts.
- [Notes & Projects](notes-and-projects.md) — markdown notes with math, and the project save/load lifecycle.
- [API Reference](../api-reference/index.md) — full reference for `pdv_tree`, `pdv`, and node types.
