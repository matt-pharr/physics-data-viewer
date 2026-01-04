# Physics Data Viewer – Fresh Build Plan (React + Vite + Electron + Jupyter kernels)

This plan guides a clean implementation using AI agents (e.g., GitHub Copilot) and iterative steps with test checkpoints. It includes detailed overall goals and a GUI specification so agents can build consistently. The focus is on: a performant Electron UI, Jupyter-kernel-backed execution (Python/Julia), a manifest-driven lazy Tree for arbitrary objects, and native-plot behavior with a capture fallback.

---

## Overall Goals (what the app is supposed to be/do)

**In short:** A modernized, trimmed-down, generalized, minimalist version of OMFIT with an Electron frontend independent of the Python/Julia environment.  The burden of keeping a module compatible with a certain Python or Julia version lies solely with the module itself, not the app.

**Core objectives:**

1. **Unified project workspace**:  Provide a desktop app (Electron) to explore, run, and manage scientific data workflows in a project-oriented way. 

2. **Language-agnostic REPL control**: Talk to Python and Julia via Jupyter kernels; no runtimes bundled. Users pick an environment/kernelspec on startup; switching kernels should not restart the UI.

3. **Central Tree as source of truth**: A lazy, manifest-driven Tree that can reference arbitrary objects and files (HDF5/Zarr/Parquet/Arrow/NPY/images/pickles/JLSO). It must:
   - Store arbitrary objects with trust-gated serialization (pickle/JLSO/JLD2).
   - Provide lazy metadata-only browsing; fetch children/content on demand. 
   - Attach default and custom actions; double-click runs the primary action.
   - Support loader hints for chunked/streamed access to large datasets. 
   - Elements lazily loaded for compatibility with large-size data on disk.

4. **Interactive execution UI**:
   - Monaco-based command boxes (cell analogues) with run-selection/full-cell, tabs for multiple scratchpads, inline error display, and duration. 
   - Console/log showing execution history (timestamps, durations, stdout/stderr/result summaries) with search/filter/clear. 

5. **Plot handling**: 
   - Default to native windows (matplotlib QtAgg/GR/GLMakie) like a normal REPL.
   - Provide a capture fallback (`pdv_show`) to return PNG/SVG when native windows aren't available or when inline viewing is desired.
   - Plot mode toggle (Native vs Capture) per session/execution.

6. **Hot reload & scripts**: 
   - Run scripts from disk; re-run after edits without restarting the kernel.
   - Python: `importlib.reload` helpers; Julia: `Revise.jl` integration (optional).
   - Standard startup namespace via init cells for both languages.

7. **Data efficiency**:
   - Chunked/streamed reads for large data (HDF5/Zarr/Parquet/Arrow/NPY); avoid blocking the renderer; offload to sidecar/worker where possible.
   - Previews/metadata first; only load heavy payloads when needed. 

8. **Extensibility via manifests**:
   - Modules can register actions for specific types/paths.
   - UI panels/cards for modules (later) driven by declarative manifests.

9. **Packaging and portability**: 
   - Ship only the Electron app (no Python/Julia bundled).
   - First-run environment selector (kernelspecs/custom commands); optional remote kernel support. 
   - Eventually distribute as an Electron app with an environment selector built in.

10. **Safety and trust**:
    - Trust gate for unsafe deserialization (pickle/JLSO/BSON). Only load from trusted sources. 

---

## Tech Stack (locked)

- **Frontend**: Electron (with preload), React, Vite, TypeScript, Monaco editor.
- **Kernel bridge**: `@jupyterlab/services` (Jupyter protocol) in Electron main.
- **Plot behavior**: Native windows by default; capture fallback via helper (`pdv_show`) for PNG/SVG.
- **Data**: Lazy loaders for HDF5/Zarr/Parquet/Arrow/NPY/Image; pickle/JLSO for unknowns (trust-gated).
- **Packaging**: `electron-builder`.

---

## GUI Specification (detailed)

**Overall layout (desktop-first):**

```
+-----------------------------------------------------------------------+
| Header:  App title | Connection status | Kernel/env selector (future)  |
+------------------+----------------------------------------------------+
|                  |                                                    |
|   Tree Pane      |   Console / Log (right-top)                        |
|   (left)         |   - Read-only execution history                    |
|                  |   - Timestamps, durations, stdout/stderr/results   |
|   Tabs:           |   - Search/filter/clear                            |
|   [Namespace]    |                                                    |
|   [Tree]         +----------------------------------------------------+
|   [Modules]      |                                                    |
|                  |   Command Box / Cells (right-bottom)               |
|   Virtualized    |   - Monaco editor (required)                       |
|   lazy tree      |   - Tabs for multiple scratchpads                  |
|   Key|Type|Value |   - Execute / Clear buttons                        |
|                  |   - Inline error bar, exec duration                |
|                  |   - Plot mode toggle (Native vs Capture)           |
+------------------+----------------------------------------------------+
| Status Bar:  kernel status | env name | cwd | plot mode | last exec    |
+-----------------------------------------------------------------------+
```

**Left pane (Tree area):**
- Fixed width ~320–380px, scrollable, sticky header.
- Tabs above tree: `Namespace | Tree | Modules` (Tree is default).
- Virtualized, lazy-loaded Tree with expand/collapse.
- Columns: Key, Type, Preview (value snippet); header is sticky.
- Node schema: `{ id, key, path, type, preview?, hasChildren, sizeBytes?, shape?, dtype?, loaderHint?, actions? }`.
- Default double-click action per type; context menu with available actions.
- Icons/badges for types; loading spinners on expand.
- Lazy: expanding fetches children; viewing fetches content. 

**Right-top (Console / Log):**
- Read-only log of executions with timestamps, duration, stdout/stderr/result summaries.
- Filters/search; Clear; (optional) Export.
- Optional Monaco read-only for code snippets in log entries.

**Right-bottom (Command Box / Cells):**
- **Monaco editor required** for code input. 
- Tabs for multiple scratchpads (add/remove).
- Run selection or full cell; Execute button; Clear button.
- Inline error bar (red); show execution duration.
- Sends execution to active kernel; capture flag toggle (native vs inline plots).
- Keyboard shortcuts (future): Ctrl/Cmd+Enter to run; Shift+Enter run+newline. 

**Status bar (bottom full width):**
- Kernel status (busy/idle), env name, cwd, plot mode (native/capture), last exec duration, connectivity indicator.

**Top header (minimal):**
- App title, connection status dot, kernel/env selector (later).

**Resizing:**
- Vertical resizer between Tree and Right pane.
- Horizontal resizer between Console and Command Box. 

**Styling:**
- Dark theme (VS Code-like). Borders at 1px #333; backgrounds around #1e1e1e–#252526; accent #4ec9b0.
- Consistent monospace fonts for code areas and tree rows (Consolas/Monaco/JetBrains Mono).

---

## Project Skeleton

```
physics-data-viewer/
├── PLAN.md
├── IMPLEMENTATION_STEPS.md
├── . gitignore
└── electron/
    ├── package.json
    ├── tsconfig.json
    ├── main/
    │   ├── app.ts
    │   ├── index.ts
    │   ├── ipc.ts
    │   ├── kernel-manager.ts
    │   └── init/
    │       ├── python-init.py
    │       └── julia-init.jl
    ├── preload.ts
    └── renderer/
        ├── index.html
        ├── tsconfig.json
        ├── vite.config.ts
        └── src/
            ├── main.tsx
            ├── app/
            │   └── index.tsx
            ├── components/
            │   ├── Tree/
            │   ├── Console/
            │   ├── CommandBox/
            │   └── StatusBar/
            ├── services/
            │   ├── rpc.ts
            │   ├── tree.ts
            │   └── kernels.ts
            └── styles/
                └── index.css
```

---

## IPC Contracts (reference)

```typescript
// Channel names
kernels: list / kernels:start / kernels:stop / kernels:execute / kernels:interrupt / kernels:restart / kernels:complete / kernels: inspect
tree:list / tree: get / tree:save
files: read / files:write
config: get / config:set

// Key types
KernelExecuteRequest { code: string; capture?:  boolean; cwd?: string; }
KernelExecuteResult { stdout?:  string; stderr?: string; result?: unknown; images?: { mime: string; data: string }[]; }
TreeNode { id: string; key:  string; path: string; type:  string; preview?: string; hasChildren: boolean; sizeBytes?: number; }
```

---

## Advice for Using AI Agents (GitHub Copilot)

1. **Constrain scope per step**: Work step-by-step; feed Copilot the interface you want (types/signatures) before asking for implementation. 
2. **Use TODO blocks**: Write the function skeleton and comments; let Copilot fill in body.  Review for API correctness.
3. **Provide examples**: When writing loader registries or IPC shapes, paste a small example object so Copilot aligns with your schema.
4. **Keep IPC contracts in one file**: Reference it often so Copilot stays consistent across main/preload/renderer.
5. **Ask for tests alongside code**: Prompt Copilot to generate Vitest specs for every new module.
6. **Guard main vs renderer**: Remind Copilot which context a file runs in (main/preload/renderer) to avoid using forbidden APIs in the renderer. 
7. **Small diffs**:  Commit frequently with small, testable changes so Copilot has less surface to drift. 
8. **Explicit backends**: In init cells, be explicit about matplotlib backend fallback logic; Copilot can guess wrong—keep it deterministic. 
9. **Security notes**: Be explicit that pickle/JLSO loads are trust-gated; Copilot may omit safety—add checks manually.
10. **Review generated types**: Ensure discriminated unions for actions/loaders; Copilot might over-widen types. 