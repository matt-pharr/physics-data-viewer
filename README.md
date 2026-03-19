# Physics Data Viewer (PDV)

A desktop environment for computational and experimental physics analysis. PDV combines a tabbed code editor with a persistent, typed data hierarchy — the **Tree** — that lives inside a Python kernel. Unlike Jupyter notebooks, the Tree gives you structured data management and reproducible analysis pipelines independent of cell-state transience.

**Status**: Alpha (`v0.0.4`) — under active development.

---

## Features

- **Tree-based data management** — persistent hierarchical data model in the kernel with lazy loading for large datasets
- **Tabbed code editor** — multi-tab Monaco editor with syntax highlighting, autocomplete, and global undo
- **Execution console** — real-time output streaming with inline error display
- **Script system** — reusable analysis workflows stored as tree nodes with typed parameter binding
- **Markdown notes** — first-class tree nodes with a dedicated Write tab, inline KaTeX math preview, and Edit/Read mode toggle
- **Namespace inspector** — live view of all kernel variables with type, shape, and size
- **Project save / load** — serialize the full analysis state (tree, scripts, code tabs) for reproducibility
- **Module system** — import and manage reusable analysis packages
- **Themes and customization** — built-in light/dark themes, system-follow mode, configurable fonts and shortcuts

---

## Download

> Releases will be available here starting with `v0.1.0-beta1`.

---

## Documentation

| Document | Description |
|----------|-------------|
| [**QUICK_START.md**](./QUICK_START.md) | Developer setup, build commands, project structure, onboarding guide |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | Authoritative design specification — process model, protocols, data model |
| [**OVERVIEW.md**](./OVERVIEW.md) | Feature overview and UI walkthrough |
| [**modules.md**](./modules.md) | Module system documentation |
| [**PLANNED_FEATURES.md**](./PLANNED_FEATURES.md) | Roadmap organized by release milestone |

---

## Quick Dev Setup

```bash
# Clone
git clone <repo-url> && cd physics-data-viewer

# Electron app
cd electron && npm install

# Python kernel package
cd ../pdv-python && pip install -e ".[dev]"

# Build & Run
cd ../electron && npm run build && npm run dev
```

See [QUICK_START.md](./QUICK_START.md) for the full guide including prerequisites, testing, and common development tasks.

---

© 2026 Matthew Pharr. All rights reserved. This code is a work in progress and is not licensed for any use, modification, or distribution without my explicit written permission.
