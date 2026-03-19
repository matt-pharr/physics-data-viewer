# Quick Start Guide

Get a development environment running and understand the codebase in under 30 minutes.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18+ | `node -v` to check |
| npm | 9+ | ships with Node |
| Python | 3.10+ | conda, venv, or system Python all work |
| Git | any | for cloning the repo |

---

## 1. Clone and Install

```bash
git clone <repo-url> && cd physics-data-viewer

# Electron app (TypeScript + React)
cd electron && npm install

# Python kernel package
cd ../pdv-python && pip install -e ".[dev]"
```

> **Tip**: Use a Python virtual environment (`python -m venv .venv && source .venv/bin/activate`) to avoid polluting your system Python.

---

## 2. Run in Development Mode

```bash
cd electron && npm run dev
```

This starts the Electron main process and the Vite dev server concurrently. The app window will open to the WelcomeScreen where you can create a new project or open an existing one. On first launch, selecting a project action will prompt you to configure a Python environment before the kernel starts.

---

## 3. Build and Test

```bash
# TypeScript build (type-checks main + renderer)
cd electron && npm run build

# Electron/main process tests (vitest, 235 tests)
cd electron && npm test -- --reporter=verbose

# Python kernel tests (pytest, 154 tests)
cd pdv-python && PYTHONPATH=. pytest tests/ -q

# Unused code check
cd electron && npm run knip
```

All three should pass before opening a PR.

---

## 4. Project Structure at a Glance

```
physics-data-viewer/
├── ARCHITECTURE.md          ← Start here — authoritative design spec
├── QUICK_START.md           ← You are here
├── OVERVIEW.md              ← Feature overview
│
├── electron/                ← Electron desktop app (TypeScript)
│   ├── main/                ← Node.js main process
│   │   ├── index.ts             IPC handler registration (entry point)
│   │   ├── ipc.ts               ALL IPC channel names + types (single source of truth)
│   │   ├── kernel-manager.ts    Kernel subprocess lifecycle (ZeroMQ)
│   │   ├── comm-router.ts       PDV comm protocol message routing
│   │   ├── kernel-error-parser.ts  Traceback parsing for error display
│   │   ├── ipc-register-*.ts    IPC handler groups (kernels, project, modules, etc.)
│   │   ├── project-manager.ts   Project manifest read/write
│   │   ├── environment-detector.ts  Python/Julia env discovery
│   │   ├── config.ts            App config persistence (~/.PDV/)
│   │   ├── app.ts               BrowserWindow lifecycle
│   │   └── bootstrap.ts         Electron app entry point
│   │
│   ├── preload.ts           ← contextBridge: exposes window.pdv to renderer
│   │
│   └── renderer/src/        ← React frontend
│       ├── app/
│       │   ├── index.tsx        Root App component (state orchestration)
│       │   ├── HOOKS.md         Hook composition documentation
│       │   ├── use*.ts          Custom hooks (7 total — see HOOKS.md)
│       │   └── ...
│       ├── components/
│       │   ├── CodeCell/        Tabbed Monaco editor
│       │   ├── WriteTab/        Markdown note editor (KaTeX math, Edit/Read mode)
│       │   ├── Console/         Execution output log
│       │   ├── Tree/            Hierarchical data browser
│       │   ├── NamespaceView/   Kernel variable inspector
│       │   ├── SettingsDialog/  Multi-tab settings modal
│       │   └── ModulesPanel/    Module import/install UI
│       ├── types/pdv.d.ts   ← Renderer-side API types
│       ├── themes.ts        ← Built-in theme definitions
│       └── shortcuts.ts     ← Keyboard shortcut registry
│
└── pdv-python/              ← Python kernel package
    ├── pdv_kernel/
    │   ├── tree.py              PDVTree (dict subclass), PDVScript, PDVNote
    │   ├── comms.py             Comm target registration, message dispatch
    │   ├── namespace.py         Protected kernel namespace
    │   ├── serialization.py     Type detection, format readers/writers
    │   └── handlers/            One file per message domain (lifecycle, project, tree, namespace, script, note)
    └── tests/
```

---

## 5. The Three-Process Architecture

```
┌─────────────┐     window.pdv     ┌─────────────┐      ZeroMQ      ┌─────────────┐
│  Renderer    │ ◄───(preload)───► │    Main      │ ◄──(Jupyter)──► │   Kernel     │
│  (React)     │                   │  (Node.js)   │                  │  (Python)    │
│              │                   │              │                  │              │
│ Tree panel   │                   │ IPC handlers │                  │ pdv_tree     │
│ Code editor  │                   │ Kernel mgmt  │                  │ Code exec    │
│ Console      │                   │ Filesystem   │                  │ Comm handler │
│ Settings     │                   │ Config       │                  │ Serialization│
└─────────────┘                    └─────────────┘                   └─────────────┘
```

**Key rule**: The renderer never touches Node.js or the filesystem directly. Everything goes through `window.pdv.*` (defined in `preload.ts`).

---

## 6. Common Development Tasks

### Adding an IPC channel

1. Define the channel name and types in `electron/main/ipc.ts`
2. Add the handler in the appropriate `ipc-register-*.ts` file
3. Expose it in `preload.ts` via `contextBridge`
4. Add the type to `renderer/src/types/pdv.d.ts`

### Adding a React component

Components live in `renderer/src/components/<Name>/index.tsx`. Types come from `../types/pdv.d.ts` — never import from `../../main/ipc`.

### Adding a PDV comm message type

1. Add the type string to `electron/main/pdv-protocol.ts`
2. Add the Python handler in `pdv-python/pdv_kernel/handlers/`
3. Register the handler in `pdv_kernel/comms.py`

### Running a single test file

```bash
cd electron && npm test -- main/kernel-manager.test.ts
cd pdv-python && PYTHONPATH=. pytest tests/test_tree.py -v
```

---

## 7. Key Concepts to Understand

Read these in order for the fastest onboarding:

1. **ARCHITECTURE.md §1–2** — What PDV is, the three-process model
2. **ARCHITECTURE.md §3** — The PDV comm protocol (how main ↔ kernel talk)
3. **ARCHITECTURE.md §11** — IPC boundary, preload API, push subscriptions
4. **`electron/main/ipc.ts`** — The single source of truth for all IPC
5. **`electron/renderer/src/app/HOOKS.md`** — How the React app is wired together
6. **ARCHITECTURE.md §7** — The Tree data model (what makes PDV unique)

---

## 8. Troubleshooting

| Problem | Solution |
|---------|----------|
| `pdv-python` not found at startup | Run `pip install -e .` inside `pdv-python/` |
| Kernel won't start | Check that the Python path in settings points to a Python with `ipykernel` installed |
| TypeScript build errors | Run `npm install` in `electron/`, then `npm run build` |
| Tests fail with import errors | Make sure you're running from the correct directory (`electron/` or `pdv-python/`) |
| Knip reports false positives | Check `electron/knip.json` — types in `pdv.d.ts` are intentionally ignored |
