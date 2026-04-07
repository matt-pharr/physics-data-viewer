# Physics Data Viewer (PDV) — Overview

PDV is an Electron desktop environment for computational and experimental physics workflows. Its core differentiator from a Jupyter notebook is the **Tree**: a typed, persistent, navigable data hierarchy that lives in the kernel and can be saved/loaded independently of ad hoc notebook cell state.

## Process model

PDV uses a strict three-process architecture:

```
Renderer (React) ──window.pdv──► Preload ──ipcRenderer──► Main (Node.js) ──ZeroMQ──► Kernel (Python)
```

- **Renderer (`electron/renderer/src`)**: UI only (Tree panel, command editing, console, namespace view). No direct Node.js or filesystem access.
- **Preload (`electron/preload.ts`)**: typed bridge exposing `window.pdv`.
- **Main (`electron/main`)**: owns kernel lifecycle, ZeroMQ sockets, project/config filesystem access, and IPC handler registration.
- **Kernel (`pdv-python/pdv_kernel`)**: owns `PDVTree`, namespace protection, serialization, and PDV protocol handlers.

For authoritative architecture details, see `ARCHITECTURE.md` §2 and §11.

## The PDV comm protocol

Structured application data flows over the Jupyter comm channel target **`pdv.kernel`**. PDV internal operations (tree list/get, project save/load, namespace query, script registration) are exchanged as typed protocol messages rather than code strings sent through `execute_request`. This keeps responsibilities clear, improves type safety, and avoids code-string injection for core app operations.

Protocol details and message envelopes are specified in `ARCHITECTURE.md` §3.

## The Tree

`PDVTree` in the kernel is the single source of truth for project data. The main process does not reconstruct or cache authoritative tree state by scanning files. The renderer always asks through protocol endpoints (for example, `pdv.tree.list`, `pdv.tree.get`) and receives descriptors/value payloads from the kernel.

Tree nodes support lazy loading, so metadata can remain responsive while heavy payloads are deserialized only when requested.

See `ARCHITECTURE.md` §7.

## `pdv-python` package

`pdv-python` provides the kernel-side runtime:

- `PDVTree`, `PDVScript`, `PDVNote`, lazy-load and serialization logic
- comm target registration and dispatch
- namespace protection (`pdv_tree` and `pdv` are protected bindings)
- save/load, tree, script, lifecycle, and namespace handlers

On kernel startup (triggered when the user selects an action from the WelcomeScreen), `bootstrap()` registers the comm target, injects `pdv_tree`/`pdv`, and emits readiness signaling used by the main-process handshake.

See `ARCHITECTURE.md` §5.

## Renderer UI components

Primary renderer components live under `electron/renderer/src/components`:

- **CodeCell**: tabbed code editing and execution submission
- **WriteTab**: tabbed markdown note editor with inline KaTeX math preview, Edit/Read mode toggle, and auto-save
- **Console**: execution outputs, errors, and result display
- **Tree**: hierarchical data navigation and node actions
- **NamespaceView**: filtered namespace variable listing
- **EnvironmentSelector**: runtime executable selection/validation UX
- **SettingsDialog**: configuration editing and app preferences

The renderer entry orchestration is in `electron/renderer/src/app/index.tsx`.

## Renderer API surface (`window.pdv`)

The frontend interacts with the backend only via the preload bridge:

- `kernels`: lifecycle, execute, completion/inspect, validation, streamed output subscription (`onOutput`)
- `tree`: list/get/createScript/createNote + tree-change subscription (`onChanged`)
- `namespace`: variable query
- `note`: save/read markdown note content (direct file I/O, no kernel round-trip)
- `script`: edit
- `project`: save/load/new + project-loaded subscription (`onLoaded`)
- `config`: get/set
- `about`: version read (`getVersion`)
- `themes`: load/save custom themes
- `codeCells`: load/save tab state
- `files`: native pickers (executable/directory)
- `menu`: recent-project sync and menu action subscription

See `ARCHITECTURE.md` §11.2 for the canonical contract.

## Markdown Notes

PDV supports markdown notes as first-class tree nodes. Notes are backed by `.md` files and edited in a dedicated **Write tab** — a sibling of the Code tab in the middle pane. The Write tab provides:

- **Tabbed editor**: Multiple notes can be open simultaneously, each in its own tab with unsaved-change indicators.
- **Inline KaTeX math preview**: `$...$` (inline) and `$$...$$` (display) math expressions are rendered live alongside the LaTeX source using KaTeX.
- **Edit/Read mode toggle**: Switch between the Monaco editor with inline math previews and a fully rendered markdown view (using `marked` + `marked-katex-extension`).
- **Auto-save**: Content is saved to disk with a 5-second debounce after the last change.

Notes are created via the tree panel context menu ("New Note") or programmatically via `pdv.new_note(path)`. On project save, `.md` files are copied into the save directory; on load, they are restored to the working directory and re-registered in the tree.

See `ARCHITECTURE.md` §5.8 and §7.2 for the data model details.

## Developer setup

Install and run from the repository root:

```bash
# Install Python package (editable + dev deps)
cd pdv-python
python -m pip install -e ".[dev]"

# Install Electron dependencies
cd ../electron
npm install
```

Run tests:

```bash
# Python tests
cd pdv-python
pytest tests/ -v --tb=short

# TypeScript tests
cd ../electron
npm test -- --reporter=verbose
```

Build and launch:

```bash
cd electron
npm run build
npm run dev
```

## Key design decisions before touching code

- Main process must not send `execute_request` to call PDV internal protocol operations.
- Main process must not build authoritative tree state from filesystem scanning.
- Renderer accesses backend functionality only via `window.pdv.*` (not raw IPC channels).
- `pdv_tree` is protected in kernel namespace and must not be reassignable by user code.

## Pointer map

| If you want to understand... | Read... |
|---|---|
| Full architecture and invariants | `ARCHITECTURE.md` |
| Comm protocol envelope/types/versioning | `ARCHITECTURE.md` §3 and `electron/main/pdv-protocol.ts` |
| Kernel process lifecycle and execution | `electron/main/kernel-manager.ts`, `ARCHITECTURE.md` §4 |
| IPC surface and renderer bridge | `electron/main/ipc.ts`, `electron/main/index.ts`, `electron/preload.ts` |
| Tree model and save/load authority | `ARCHITECTURE.md` §7 and `pdv-python/pdv_kernel/tree.py` |
| Kernel bootstrap and handlers | `pdv-python/pdv_kernel/comms.py`, `pdv-python/pdv_kernel/handlers/` |
| Modules feature behavior and manifest syntax | `modules.md` |
| Future roadmap items | `PLANNED_FEATURES.md` |
