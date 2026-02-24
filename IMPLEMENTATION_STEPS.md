# PDV Rewrite — Implementation Steps

## Briefing for a fresh agent starting on any step

This project is a rewrite of a physics data viewer desktop app (Electron + Python). The rewrite is in progress. Read the following before starting any step:

1. **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — the complete authoritative design specification. Every architectural decision is recorded there. Read it in full before writing code.
2. **[`legacy/README.md`](legacy/README.md)** — brief explanation of why the old code was replaced.
3. **`legacy/electron/main/init/python-init.py`** — the old monolithic Python init file. Contains working implementations of `PDVTree`, `PDVScript`, serialization, and tree helpers that may be useful as reference when implementing Steps 1–2. Do not copy it wholesale — the new package has a different structure and interface — but the serialization logic and type detection are worth consulting.
4. **`legacy/electron/main/`** — old Electron backend. Useful reference for Steps 3–6 (kernel-manager, IPC shapes). Do not copy — the new architecture is meaningfully different.

**The `electron/renderer/` directory is untouched and must not be modified until Step 7.**

---

Each step is sized to complete in a single agent session. Steps must be done in order — each step's deliverables are prerequisites for the next. At the end of each step, a specific set of tests can be run to confirm correctness before proceeding.

Reference: `ARCHITECTURE.md` is the authoritative design specification for all steps.

---

## Step 1 — `pdv-python`: Data Structures (no comms, no IPython)

**Goal**: Implement the core Python data structures that the rest of the package depends on, fully testable without a running kernel or IPython.

### Files created
```
pdv-python/
    pyproject.toml                  ← package metadata, dependencies (numpy, pandas optional)
    pdv_kernel/
        __init__.py                 ← exports: PDVTree, PDVScript, PDVError
        tree.py                     ← PDVTree, PDVScript, lazy-load registry
        environment.py              ← path utilities, working dir helpers, project root logic
        serialization.py            ← type detection, format readers/writers (npy, parquet, json, txt, pickle)
    tests/
        conftest.py                 ← shared fixtures (tmp working dir, sample PDVTree)
        test_tree.py
        test_serialization.py
        test_environment.py
```

### What is implemented
- `PDVTree`: dict subclass with dot-path `__getitem__`/`__setitem__`/`__delitem__`, lazy-load registry, `run_script()`, `__repr__`
- `PDVScript`: relative_path, language, doc, `run()`, `preview()`
- `PDVError`: base exception for all pdv_kernel errors
- `LazyLoadRegistry`: internal class (not user-facing) mapping tree paths to save-directory storage references
- `serialization.py`: `detect_kind(value)`, `serialize_node(path, value, working_dir)`, `deserialize_node(storage_ref, save_dir)` — supports ndarray, dataframe, series, scalar, text, mapping, sequence, script, binary, unknown (pickle, gated on `trusted=True`)
- `environment.py`: `make_working_dir(base_tmp_dir)`, `resolve_project_path(relative, root)`, `path_is_safe(candidate, root)` — all path traversal checks live here

### What is NOT implemented in this step
- Comms, IPython, bootstrap — those are Step 2
- Protected namespace — Step 2
- Any Electron code — Steps 3–7

### Tests to confirm completion
```bash
cd pdv-python && pip install -e ".[dev]" && pytest tests/ -v
```

Specific assertions that must pass:
- `PDVTree.__setitem__` with dot-path sets nested keys
- `PDVTree.__getitem__` with dot-path retrieves nested values
- `PDVTree.__getitem__` on a lazy key triggers `LazyLoadRegistry` fetch (mocked)
- `PDVTree.__getitem__` on an absent non-lazy key raises `KeyError`
- `PDVScript.run()` loads a script file and calls its `run()` function with `pdv_tree`
- `serialize_node` + `deserialize_node` round-trips for: int, float, str, list, dict, numpy array, pandas DataFrame
- `path_is_safe` rejects `../` traversal attempts
- `make_working_dir` creates a directory under the given base path

---

## Step 2 — `pdv-python`: Comms Layer, Handlers, Bootstrap

**Goal**: Implement the IPython-facing side of the PDV comm protocol. All tests run with a mocked IPython kernel — no real kernel process is needed.

### Files created
```
pdv-python/
    pdv_kernel/
        comms.py                    ← comm target registration, send_message(), message envelope construction
        namespace.py                ← PDVNamespace (protected dict), pdv_namespace() variable inspector, PDVApp class
        handlers/
            __init__.py             ← dispatch table: type string → handler function
            lifecycle.py            ← handles pdv.init; sends pdv.ready on bootstrap
            project.py              ← handles pdv.project.load, pdv.project.save
            tree.py                 ← handles pdv.tree.list, pdv.tree.get
            namespace.py            ← handles pdv.namespace.query
            script.py               ← handles pdv.script.register
    tests/
        test_comms.py
        test_namespace.py
        test_handlers_lifecycle.py
        test_handlers_project.py
        test_handlers_tree.py
```

### What is implemented
- `comms.py`:
  - `send_message(comm, type, payload, status, in_reply_to)` — constructs and sends a correctly enveloped PDV message
  - `PDVCommTarget` — registered with IPython as `pdv.kernel`; dispatches incoming messages to handlers
  - `bootstrap(ip)` — called by IPython startup; registers comm target, injects `pdv_tree` and `pdv` into `PDVNamespace`, sends `pdv.ready`; idempotent
- `namespace.py`:
  - `PDVNamespace(dict)` — `__setitem__` raises `PDVError` for `pdv_tree` and `pdv`
  - `PDVApp` — exposes `pdv.save()`, `pdv.help()` to user
  - `pdv_namespace(include_private, include_modules, include_callables)` — returns dict of variable descriptors for all user namespace names (excluding PDV internals)
- Handlers: each handler receives a parsed `PDVMessage`, performs its action, and calls `send_message()` with the response

### What is NOT implemented in this step
- Real IPython is never imported at test time — all tests use a `MockIPython` fixture
- No real comm wire format — tests verify the `send_message` mock is called with correct arguments

### Tests to confirm completion
```bash
cd pdv-python && pytest tests/ -v
```

Specific assertions that must pass:
- `bootstrap(mock_ip)` injects `pdv_tree` and `pdv` into the mock namespace
- `bootstrap(mock_ip)` called twice does not double-inject or open a second comm
- `PDVNamespace.__setitem__('pdv_tree', x)` raises `PDVError`
- `PDVNamespace.__setitem__('pdv', x)` raises `PDVError`
- `PDVNamespace.__setitem__('my_var', x)` succeeds
- Incoming `pdv.init` message calls `lifecycle.handle_init()` and triggers `send_message` with `type='pdv.init.response'`, `status='ok'`
- Incoming `pdv.tree.list` message returns correct node array for a populated `PDVTree`
- Incoming `pdv.tree.get` message returns correct value for an in-memory node
- Incoming `pdv.tree.get` on a lazy node triggers `LazyLoadRegistry.fetch()` (mocked)
- Incoming message with unknown `type` returns `status='error'`, `code='protocol.unknown_type'`
- `pdv_namespace()` excludes `pdv_tree`, `pdv`, and names starting with `_`

---

## Step 3 — Electron: `kernel-manager.ts`

**Goal**: Implement kernel process lifecycle management and raw Jupyter Messaging Protocol communication over ZeroMQ. No PDV-specific logic — this layer only speaks standard Jupyter protocol.

### Files created
```
electron/
    main/
        kernel-manager.ts           ← process spawn, ZeroMQ sockets, execute_request, interrupt, shutdown
        kernel-manager.test.ts
```

### What is implemented
- `KernelManager` class:
  - `start(spec: KernelSpec): Promise<KernelInfo>` — spawns kernel subprocess, writes connection file, opens shell/iopub/control/hb sockets, waits for first heartbeat
  - `stop(id: string): Promise<void>` — sends `kernel_shutdown_request`, waits for clean exit (3s timeout), force-kills
  - `execute(id, request): Promise<KernelExecuteResult>` — sends `execute_request`, collects `stream`/`execute_result`/`error`/`display_data` until `execute_reply` arrives; returns structured result
  - `interrupt(id): Promise<void>` — sends interrupt signal via control socket
  - `list(): KernelInfo[]` — returns all running kernels
  - `getKernel(id): ManagedKernel | null`
  - `shutdownAll(): Promise<void>` — graceful shutdown of all kernels
  - `onIopubMessage(id, callback)` — registers a listener for all iopub messages (used by CommRouter in Step 4)
  - Crash detection: if the kernel process exits unexpectedly, emit a `kernel:crashed` event
- Message signing and verification (HMAC-SHA256) — moved from legacy code, kept intact
- Connection file creation and cleanup

### What is NOT implemented in this step
- PDV comm routing — Step 4
- IPC handlers — Step 5

### Tests to confirm completion
```bash
cd electron && npm test -- --reporter=verbose kernel-manager
```

Specific assertions that must pass:
- `start()` returns a `KernelInfo` with a valid `id` and `status: 'idle'`
- `execute()` with `code: '1 + 1'` returns `result: 2`
- `execute()` with `code: 'print("hello")'` returns `stdout: 'hello\n'`
- `execute()` with `code: 'raise ValueError("oops")'` returns `error` containing `'ValueError'`
- `stop()` causes the kernel process to exit within 3 seconds
- `shutdownAll()` stops all running kernels
- Crash detection: killing the kernel process externally triggers the `kernel:crashed` event

Note: These tests spawn real Python kernel processes. They require `ipykernel` to be installed. Marked with `@slow` and excluded from fast CI runs.

---

## Step 4 — Electron: `comm-router.ts`

**Goal**: Implement PDV comm message routing on top of the raw iopub stream from `KernelManager`. This is the layer that turns ZeroMQ frames into typed PDV messages and matches responses to pending requests.

### Files created
```
electron/
    main/
        comm-router.ts              ← CommRouter class
        comm-router.test.ts
        pdv-protocol.ts             ← PDVMessage interface, message type constants, version check
```

### What is implemented
- `pdv-protocol.ts`:
  - `PDVMessage` interface (envelope from ARCHITECTURE.md §3.2)
  - `PDV_VERSION = '1.0'`
  - `PDVMessageType` const object — all type strings from ARCHITECTURE.md §3.4 as named constants
  - `checkVersionCompatibility(msg)` — returns `ok | 'major_mismatch' | 'minor_mismatch'`
  - `isPDVMessage(raw)` — type guard
- `CommRouter` class:
  - `attach(kernelManager, kernelId)` — subscribes to `onIopubMessage` for the given kernel
  - `request(type, payload, timeoutMs?): Promise<PDVMessage>` — sends a comm_msg on the shell socket, registers a pending entry keyed by `msg_id`, returns a promise that resolves on matching `in_reply_to` or rejects on timeout/error status
  - `onPush(type, callback)` — registers a listener for unsolicited push notifications of a given type
  - `detach()` — unsubscribes from iopub, rejects all pending requests with a cancellation error
  - Internal: `_handleIopubMessage(raw)` — parses frame, validates envelope, dispatches to pending registry or push listeners

### ⚠️ Skeleton file discrepancy

The skeleton file `electron/main/comm-router.ts` was generated with a simplified constructor:

```ts
constructor(private readonly sendFn: (data: Record<string, unknown>) => Promise<void>)
```

**This is wrong.** The correct interface (as specified above and in ARCHITECTURE.md §3.3) is:

```ts
attach(kernelManager: KernelManager, kernelId: string): void
```

Ignore the skeleton constructor. Implement `CommRouter` with the `attach()` / `detach()` pattern. The skeleton is scaffolding only — ARCHITECTURE.md and these step descriptions take precedence over it in all cases.

### Tests to confirm completion
```bash
cd electron && npm test -- --reporter=verbose comm-router
```

All tests use a `MockKernelManager` — no real kernel process:

Specific assertions that must pass:
- `request()` resolves when a matching `in_reply_to` response arrives with `status: 'ok'`
- `request()` rejects with `PDVCommError` when response arrives with `status: 'error'`
- `request()` rejects with `PDVCommTimeoutError` after `timeoutMs` with no response
- Two concurrent `request()` calls each resolve to their own matching response (correct correlation)
- A push notification (no `in_reply_to`) is forwarded to the registered `onPush` listener, not treated as a response
- A message with incompatible major `pdv_version` is rejected before dispatch
- `detach()` rejects all pending requests immediately

---

## Step 5 — Electron: `ipc.ts`, `index.ts`, `preload.ts`

**Goal**: Define the complete TypeScript IPC surface and wire all IPC handlers, connecting the renderer API to `KernelManager` and `CommRouter`.

### Files created
```
electron/
    preload.ts                      ← window.pdv API bridge (fully typed)
    main/
        ipc.ts                      ← ALL IPC channel name constants and TypeScript types
        index.ts                    ← IPC handler registration (entry point for main process)
        index.test.ts
        app.ts                      ← Electron BrowserWindow lifecycle, app event handlers
```

### What is implemented
- `ipc.ts`: complete type definitions for all IPC messages matching ARCHITECTURE.md §11.2. Every interface and channel name is documented per §13 (TypeScript documentation standard). Contains no logic.
- `preload.ts`: `contextBridge.exposeInMainWorld('pdv', ...)` exposing all `window.pdv.*` namespaces. Never exposes raw Node.js APIs.
- `index.ts`:
  - `kernels.*` handlers: `list`, `start`, `stop`, `execute`, `interrupt`, `restart`, `complete`, `inspect`, `validate`
  - `tree.*` handlers: `list` (via `pdv.tree.list` comm), `get` (via `pdv.tree.get` comm), `createScript` (writes file, sends `pdv.script.register` comm)
  - `namespace.*` handler: `query` (via `pdv.namespace.query` comm)
  - `script.*` handlers: `edit` (opens external editor), `reload` (sends `pdv.script.register` comm with reload flag)
  - `config.*` handlers: `get`, `set`
  - `themes.*` handlers: `get`, `save`
  - `commandBoxes.*` handlers: `load`, `save`
  - Push notification forwarding: `pdv.tree.changed` and `pdv.project.loaded` are forwarded to renderer via `BrowserWindow.webContents.send()`
- `app.ts`: creates `BrowserWindow`, registers `before-quit` handler, nothing else

### What is NOT implemented in this step
- Project save/load coordination — Step 6
- Environment detection — Step 6

### Tests to confirm completion
```bash
cd electron && npm test -- --reporter=verbose index
```

All tests mock `KernelManager` and `CommRouter`:

Specific assertions that must pass:
- `kernels:start` IPC call returns a `KernelInfo` with correct shape
- `tree:list` IPC call sends `pdv.tree.list` comm and returns the `nodes` array from the response payload
- `tree:list` IPC call returns `[]` (not an error) when the kernel is not running
- `tree:get` IPC call sends `pdv.tree.get` comm and returns the response payload
- `namespace:query` IPC call sends `pdv.namespace.query` comm and returns `variables` array
- `script:edit` IPC call spawns the configured external editor process
- `config:get` returns the current config object
- `config:set` persists a partial config update and returns the merged result
- A `pdv.tree.changed` push notification received on CommRouter is forwarded to the renderer via `webContents.send`

---

## Step 6 — Electron: `environment-detector.ts` + `project-manager.ts`

**Goal**: Implement environment detection (for plug-and-play install) and project save/load coordination (the app-side of the save sequence from ARCHITECTURE.md §8).

### Files created
```
electron/
    main/
        environment-detector.ts     ← conda, uv, system Python detection; pdv-python install check
        environment-detector.test.ts
        project-manager.ts          ← project manifest r/w, save coordination, load coordination
        project-manager.test.ts
```

### What is implemented
- `environment-detector.ts`:
  - `detectEnvironments(): Promise<PythonEnvironment[]>` — finds conda envs (`conda env list --json`), uv venvs (`.venv` in workspace), system Python
  - `checkPDVInstalled(pythonPath): Promise<PDVInstallStatus>` — runs `python -c "import pdv_kernel; print(pdv_kernel.__version__)"`, returns `{ installed: bool, version: string | null, compatible: bool }`
  - `installPDV(pythonPath): Promise<{ success: bool, output: string }>` — runs `python -m pip install pdv-python`, streams output
  - All external process invocations have a configurable timeout and are sandboxed (no shell injection)
- `project-manager.ts`:
  - `ProjectManager` class (holds reference to `CommRouter`):
  - `createWorkingDir(): Promise<string>` — creates uniquely named dir under OS temp; returns path
  - `deleteWorkingDir(path): Promise<void>` — recursive delete
  - `saveProject(saveDir, commandBoxData): Promise<void>` — sends `pdv.project.save` comm, awaits response with checksum, writes `command-boxes.json`, writes `project.json` only on full success
  - `loadProject(saveDir): Promise<ProjectLoadResult>` — sends `pdv.project.load` comm, reads `command-boxes.json`, returns both
  - `loadManifest(saveDir): PDVProjectManifest` — reads and validates `project.json`
  - `saveManifest(saveDir, manifest): void` — writes `project.json`
  - IPC handlers added to `index.ts`: `project:save`, `project:load`, `project:new`

### Tests to confirm completion
```bash
cd electron && npm test -- --reporter=verbose environment-detector project-manager
```

Specific assertions that must pass:
- `detectEnvironments()` returns an array with at least the system Python (CI always has Python)
- `checkPDVInstalled(validPythonPath)` returns `{ installed: true }` when pdv_kernel is importable
- `checkPDVInstalled('/nonexistent/python')` returns `{ installed: false }`
- `saveProject()` sends `pdv.project.save` comm, then writes `command-boxes.json`, then writes `project.json` — in that order, with the comm awaited before either file write
- `saveProject()` does NOT write `project.json` if the comm response has `status: 'error'`
- `loadProject()` sends `pdv.project.load` comm and reads `command-boxes.json` from the save directory
- `loadManifest()` with a missing `project.json` returns a default manifest (does not throw)
- `loadManifest()` with a future schema major version throws `PDVSchemaVersionError`
- `createWorkingDir()` creates a directory that exists on disk
- `deleteWorkingDir()` removes the directory

---

## Step 7 — Renderer: Wire to New IPC Surface

**Goal**: Update the existing React frontend to use the new `window.pdv` API. This step makes the app functional end-to-end for the first time since the rewrite.

### Files modified
```
electron/renderer/src/
    components/
        Tree/index.tsx              ← use window.pdv.tree.list, handle pdv.tree.changed push
        NamespaceView/index.tsx     ← use window.pdv.namespace.query
        CommandBox/index.tsx        ← use window.pdv.kernels.execute
        Console/index.tsx           ← consume execution results
        EnvironmentSelector/index.tsx ← use environment detection API
    services/
        tree.ts                     ← update to new TreeNode shape (remove FileScanner assumptions)
    types/
        pdv.d.ts                    ← update to match new ipc.ts types
```

### What is implemented
- Tree panel: calls `window.pdv.tree.list(kernelId, path)` on expand; listens for `pdv.tree.changed` IPC push and re-fetches affected subtree
- Namespace panel: calls `window.pdv.namespace.query(kernelId, options)` on refresh
- Command Box: calls `window.pdv.kernels.execute(kernelId, request)` on run; output flows to Console
- Environment Selector: calls environment detection IPC; shows install prompt if `pdv-python` is missing
- All references to `FileScanner`, `pdv_tree_snapshot`, `pdv_namespace`, and code-string IPC patterns are removed

### What is NOT changed in this step
- Visual layout and styling — no UX changes
- Component structure — only data flow is updated

### Tests to confirm completion
There are no automated tests for the renderer in alpha. Confirmation is by manual smoke test:

1. Launch app (`npm run dev` or equivalent)
2. App detects Python environment and confirms `pdv-python` is installed (or prompts to install)
3. Kernel starts; UI unlocks
4. Tree panel shows empty tree (working directory root)
5. Typing `pdv_tree['x'] = 42` in the Command Box and running it causes the tree panel to refresh and show node `x`
6. Namespace panel shows `pdv_tree` and `pdv` as protected names, plus `x`
7. File → Save Project saves to a chosen directory; `project.json`, `tree-index.json`, `command-boxes.json` are present in the directory
8. Restart app, File → Open Project loads the directory; tree panel repopulates with node `x`, command box tabs are restored

---

## Step 8 — Full Test Suite Pass + Documentation Audit

**Goal**: All automated tests pass. All new files meet the TypeScript documentation standard from ARCHITECTURE.md §13. The codebase is ready for continued alpha development.

### Actions
- Run full test suite and fix any failures:
  ```bash
  cd pdv-python && pytest tests/ -v
  cd electron && npm test -- --reporter=verbose
  ```
- Audit every `.ts` file in `electron/main/` against §13 documentation standard:
  - File header present and accurate
  - Every exported symbol has JSDoc with `@param`, `@returns`, `@throws`
  - Every `ipcMain.handle` registration has an inline comment
  - No unguarded `any` types
- Audit `pdv-python` against Python docstring conventions (NumPy style):
  - Every public class and function has a docstring
  - Every parameter and return value documented
- Update `README.md` with new developer setup instructions (how to install `pdv-python` in dev mode, how to run tests)
- Update `TEST-COVERAGE.md` documenting what is and is not covered

### Tests to confirm completion
```bash
# Python
cd pdv-python && pytest tests/ -v --tb=short

# TypeScript
cd electron && npm test -- --reporter=verbose

# Both must exit 0
```

Additionally, `npm run build` (or equivalent) must succeed without TypeScript errors.

---

## Step 9 — Legacy Cleanup + OVERVIEW.md Overhaul

**Goal**: Remove all legacy code now that the rewrite is complete and functional. Rewrite `OVERVIEW.md` so it accurately describes the current system — not the old one — and can serve as a useful entry point for new contributors.

This step has no code changes and no new tests. It is purely a cleanup and documentation pass, done only after Step 8 (all tests green, TypeScript build clean).

---

### Part A — Delete the `legacy/` directory

The `legacy/` directory was preserved during the rewrite as a reference for implementation decisions. That reference purpose is now exhausted.

**Before deleting**, verify that:
- All test files in `electron/main/*.test.ts` and `pdv-python/tests/` pass without importing anything from `legacy/`
- No import or require statement in `electron/` or `pdv-python/` references a path under `legacy/`
- `IMPLEMENTATION_STEPS.md` references to `legacy/` (the briefing section at the top) have been updated to remove those pointers

**Then delete**:
```bash
rm -rf legacy/
```

Also remove the briefing bullets at the top of this document that reference `legacy/` as a code reference, since those files no longer exist.

---

### Part B — Rewrite `OVERVIEW.md`

`OVERVIEW.md` currently describes the old (pre-rewrite) architecture and is explicitly marked as legacy-only. Rewrite it from scratch so it:

1. **Describes the current system** — the three-process Electron model, the PDV comm protocol, `pdv-python`, the Tree authority model, and the IPC surface
2. **Serves as an entry point for new contributors** — someone reading it should understand *what* the system does and *why* it is structured the way it is, with pointers to the authoritative detail (ARCHITECTURE.md)
3. **Does not duplicate ARCHITECTURE.md** — OVERVIEW.md is a guided summary, not a specification. It should answer "what is this and how does it work?" not "what exactly is the message envelope schema?" Those answers live in ARCHITECTURE.md.

#### Required sections

- **What PDV is** — one concise paragraph. The core value proposition: Tree + command workflow as a physics analysis environment. The key differentiator from Jupyter.
- **Process model** — describe the three processes (main, renderer, kernel) and what each owns. Include the ASCII diagram from ARCHITECTURE.md §2 (or a simplified version).
- **The PDV comm protocol** — one short section. Explain that all structured data flows via a Jupyter comm channel (`pdv.kernel`), not via `execute_request`. Why: clean separation, no code-string injection. Pointer to ARCHITECTURE.md §3 for the full spec.
- **The Tree** — explain the single-authority rule, lazy loading, and why `PDVTree` lives in the kernel rather than the app. Pointer to ARCHITECTURE.md §7.
- **pdv-python package** — what it is, how it is installed, what `bootstrap()` does. Pointer to ARCHITECTURE.md §5.
- **Renderer UI components** — brief list of the React components (CommandBox, Console, Tree panel, Namespace panel, EnvironmentSelector, Settings), what each does, and where they live.
- **Developer setup** — clear, copy-pasteable commands to:
  - Install `pdv-python` in dev mode
  - Install Electron dependencies
  - Run Python tests
  - Run TypeScript tests
  - Build and launch the app
- **Key design decisions to know before touching the code** — a short bullet list of the "do not do this" rules that are easy to violate unknowingly:
  - Main process never sends `execute_request` to call PDV internal functions
  - Main process never builds tree state from filesystem scanning
  - Renderer only accesses the kernel via `window.pdv.*` (never raw IPC channels)
  - `pdv_tree` is protected in the kernel namespace — never reassignable by user code
- **Pointer map** — a simple table: "If you want to know about X, read Y" linking the major topics to the right document and section.

#### Tone

Write it as you would write a README for an open-source project that you want a competent software engineer to be able to read in 10 minutes and know exactly what they are looking at.

---

### Tests to confirm completion

There are no automated tests for this step. Completion criteria:

- `legacy/` directory does not exist
- No import or reference to `legacy/` anywhere in the codebase
- `OVERVIEW.md` no longer contains the "This document describes the legacy architecture" warning banner
- `OVERVIEW.md` accurately describes the system that exists after Step 8

---

## Dependency Summary

```
Step 1 (PDVTree, serialization)
    └─► Step 2 (comms, handlers, bootstrap)
            └─► Step 3 (KernelManager — process + sockets)
                    └─► Step 4 (CommRouter — PDV protocol routing)
                            └─► Step 5 (IPC handlers, preload)
                                    └─► Step 6 (env detector, project manager)
                                            └─► Step 7 (renderer wiring)
                                                    └─► Step 8 (full test pass)
                                                            └─► Step 9 (legacy cleanup + OVERVIEW.md)
```

Steps 1 and 2 produce a standalone Python package with no Electron dependency.  
Steps 3 and 4 produce a standalone Electron module with no renderer dependency.  
Step 5 is the first step where the Python package and Electron module must work together.  
Step 7 is the first step where a human must look at the running UI to confirm correctness.
