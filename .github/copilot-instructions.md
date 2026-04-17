# GitHub Copilot Instructions for PDV

## What this repository is

PDV (Physics Data Viewer) is an Electron desktop application for computational and experimental physics analysis. It provides a tabbed Python command editor, an execution console, and a persistent hierarchical data model called the **Tree** that lives inside a Jupyter kernel. The Tree is what distinguishes PDV from a Jupyter notebook — it is a typed, navigable, save/load-able data hierarchy that persists across sessions.

The authoritative design specification is **`ARCHITECTURE.md`** in the root directory. Read it before making non-trivial changes.

---

## Repository layout

```
ARCHITECTURE.md          ← authoritative design spec — always consult this first
PLANNED_FEATURES.md      ← planned features organised by release milestone

electron/                ← Electron app (TypeScript)
    main/                ← Node.js main process (kernel management, IPC, filesystem)
        ipc.ts           ← SINGLE SOURCE OF TRUTH for all IPC channel names and types
        index.ts         ← ipcMain handler registration (entry point)
        kernel-manager.ts
        comm-router.ts
        pdv-protocol.ts  ← PDV comm protocol types and constants
        app.ts           ← BrowserWindow lifecycle
        config.ts
        environment-detector.ts
        project-manager.ts
    preload.ts           ← exposes window.pdv API to renderer via contextBridge
    renderer/src/        ← React frontend
        app/index.tsx    ← root component; orchestrates all kernel lifecycle and state
        components/      ← Tree, CodeCell, WriteTab, Console, NamespaceView, EnvironmentSelector, ...
        services/        ← tree.ts data-fetching service
        types/pdv.d.ts   ← all types used by renderer; re-exports from ipc.ts

pdv-python/              ← Python kernel package (pip install pdv-python)
    pdv_kernel/
        __init__.py
        tree.py          ← PDVTree (dict subclass), PDVScript, PDVFile, PDVNote
        comms.py         ← comm target registration, message dispatch, bootstrap()
        namespace.py     ← PDVNamespace (protected dict), PDVApp, pdv_namespace()
        serialization.py ← type detection, format readers/writers
        environment.py   ← working dir helpers, path safety checks
        handlers/        ← one file per PDV message domain (lifecycle, project, tree, script, note, ...)
    tests/
```

---

## Three-process architecture

```
Renderer (React) ──window.pdv──► Preload ──ipcRenderer──► Main (Node.js) ──ZeroMQ──► Kernel (Python)
```

- **Renderer** never accesses Node.js or the filesystem directly. All communication goes through `window.pdv.*`.
- **`window.pdv`** is defined in `preload.ts` using Electron's `contextBridge`. It is the only bridge between renderer and main.
- **Main process** owns ZeroMQ sockets, kernel lifecycle, filesystem, and config. All IPC channel names are constants in `ipc.ts`.
- **Kernel** runs `ipykernel` + `pdv-python`. It communicates with the main process via a custom Jupyter comm channel (`pdv.kernel`) layered on top of ZeroMQ.

---

## Key design rules

1. **`ARCHITECTURE.md` is authoritative.** If code contradicts it, the code is wrong. If you need to deviate, update the document first.

2. **`ipc.ts` is the single source of truth for all IPC.** Channel names, request/response types, and the `PDVApi` interface all live there. Preload and index.ts consume them — they do not define their own strings.

3. **The Tree is the sole data authority.** `PDVTree` in the kernel is the only source of truth for project data. The main process never caches tree state. The renderer always fetches via `pdv.tree.list` / `pdv.tree.get`.

4. **Renderer types come from `types/pdv.d.ts`, never from `../../main/ipc`.** Importing across the process boundary in the type system breaks the build when tsconfig roots are separated.

5. **Script execution goes through `window.pdv.script.run()`.** The renderer dispatches `{ treePath, params, executionId, origin }` to the main process; the main process builds the language-appropriate invocation string (Python or Julia), calls `kernels.execute`, and returns `{ code, executionId, origin, result }` so the renderer can log the run in the console. No Python or Julia code strings belong in the renderer.

6. **`kernels.start()` encapsulates the full handshake.** The `pdv.ready → pdv.init → pdv.init.response` sequence is entirely inside the main process's `kernels.start()` handler. The renderer only `await`s it.

7. **Push subscriptions are owned by `App`, keyed on `currentKernelId`.** One `useEffect` in `app/index.tsx` subscribes to `tree.onChanged` and `project.onLoaded`, and tears them down on cleanup. Child components receive refresh tokens as props; they do not subscribe directly.

8. **Scripts follow a fixed structure.** Every PDV script defines `run(pdv_tree: dict, **user_params) -> dict`. The `pdv_tree` argument is always injected by `PDVScript.run()` and is never supplied by the user — it is present in the signature so language servers don't flag tree references as errors.

9. **Historical rewrite scaffolding is removed.** Do not add imports to deleted historical paths; use current architecture modules only.

10. **Unified version number.** `electron/package.json` version and `pdv-python/pyproject.toml` version must always match. This single version is used as the protocol version in comm messages, stored in project manifests, and checked by the environment detector. When bumping the version, update both files.

11. **Always use theme-engine CSS variables for colors.** New GUI elements must reference tokens like `var(--bg-primary)`, `var(--text-primary)`, `var(--accent)`, `var(--text-on-accent)`, etc. — defined in `electron/renderer/src/themes.ts` and exposed via the Appearance settings editor. Never hardcode hex colors (`#fff`, `#007acc`, etc.) or `rgb(...)` literals in component CSS. If you need a color that isn't in the token set, add it to `themes.ts` (with per-theme values and a `CSS_VAR_GROUPS` entry) rather than hardcoding it. This keeps every built-in and custom theme looking correct.

---

## Testing

```bash
# Python unit tests (no kernel required)
cd pdv-python && pytest tests/ -v

# TypeScript unit tests
cd electron && npm test -- --reporter=verbose

# Integration tests (requires Python + ipykernel in PYTHON_PATH env)
cd electron && PYTHON_PATH=/path/to/python npm test -- --reporter=verbose main/integration.test.ts
```

There are no automated tests for the renderer. The renderer is verified by manual smoke test.

---

## TypeScript documentation standard (ARCHITECTURE.md §13)

Every `.ts` file in `electron/main/` must have:
- A JSDoc file header describing purpose, responsibilities, and what the file does NOT do
- JSDoc on every exported function and class with `@param`, `@returns`, `@throws`
- No unguarded `any` types
