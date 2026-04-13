# Physics Data Viewer (PDV)

A desktop environment for computational and experimental physics analysis. PDV combines a tabbed code editor, an execution console, and a persistent, typed data hierarchy, the **Tree**, that lives inside a language kernel. The Tree is what separates PDV from a Jupyter notebook: it is a navigable, save/load-able data structure that persists across sessions, giving you structured data management and reproducible analysis workflows.

**Status**: Alpha (`v0.0.10`) — under active development.

![PDV screenshot](screenshot.png)

---

## Features

- **Persistent data tree** — hierarchical data model in the kernel with typed nodes (arrays, DataFrames, scalars, scripts, notes, modules) and lazy loading
- **Tabbed code editor** — Monaco (VS Code style) editor with syntax highlighting, Jupyter-powered autocomplete, hover documentation, and multi-tab workflow
- **Execution console** — real-time output streaming with inline plots, error display, and rich output
- **Script system** — reusable analysis scripts stored as tree nodes with typed parameters and a run dialog
- **Module system** — import, share, and manage reusable analysis packages with declarative GUIs, namelists, and library code
- **Editable GUIs** — create custom GUIs with a live-editing drag-and-drop interface for setting up and running analyses with complex variable input parameters
- **Namelist editor** — structured editing for Fortran namelist and TOML configuration files
- **Markdown notes** — notes stored in the tree with LaTeX math rendering and Edit/Read mode toggle
- **Namespace inspector** — live view of kernel variables with type, shape, and lazy child inspection
- **Project save/load** — serialize the full analysis state into a portable directory
- **Themes and customization** — built-in light/dark themes, VS Code-style appearance, configurable fonts and keyboard shortcuts

---

## Download

Download the latest release for your platform (macOS, Linux currently, Windows support planned for a future release):

**[Latest Release](https://github.com/matt-pharr/physics-data-viewer/releases/latest)**

After installing the app, you'll be prompted to install the `pdv-python` kernel package into your Python environment on first launch.

---

## Documentation

| Resource | Description |
|----------|-------------|
| [**User Guide**](https://matt-pharr.github.io/physics-data-viewer/) | Getting started, tutorials, and API reference |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | Design specification — process model, protocols, data model |
| [**modules.md**](./modules.md) | Module system: creating, publishing, and importing modules |
| [**PLANNED_FEATURES.md**](./PLANNED_FEATURES.md) | Roadmap organized by release milestone |

---

## Contributing

PDV welcomes contributions. See the [contributor guide](./QUICK_START.md) for full setup instructions.

### Quick Dev Setup

PDV uses npm for the Electron app. See a guide on installing Node.js and npm [here](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

```bash
# Clone
git clone https://github.com/matt-pharr/physics-data-viewer.git
cd physics-data-viewer

# Electron app
cd electron && npm install

# Python kernel package
cd ../pdv-python && pip install -e ".[dev]"

# Build & run
cd ../electron && npm run build && npm run dev
```

### Running Tests

```bash
# Python
cd pdv-python && pytest tests/ -v

# TypeScript
cd electron && npm test -- --reporter=verbose
```

### Repository Layout

```
electron/            Electron app (TypeScript)
  main/              Main process — kernel management, IPC, filesystem
  renderer/src/      React frontend — tree, editor, console, modules
pdv-python/          Python kernel package (pip install pdv-python)
  pdv_kernel/        Tree, comm protocol, serialization, handlers
examples/modules/    Bundled example modules
```

---

## License

MIT License — see [LICENSE](./LICENSE.md) for details.

---

© 2026 Matthew Pharr
