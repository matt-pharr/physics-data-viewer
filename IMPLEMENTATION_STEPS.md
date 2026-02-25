# PDV Rewrite — Implementation Steps

## Briefing for a fresh agent starting on any step

This project is a rewrite of a physics data viewer desktop app (Electron + Python). Read the following before starting any step:

1. **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — the complete authoritative design specification. Every architectural decision is recorded there. Read it in full before writing code.
2. **[`OVERVIEW.md`](OVERVIEW.md)** — high-level architecture and contributor orientation.
3. **[`README.md`](README.md)** — developer setup, test, and build commands.

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
- Message signing and verification (HMAC-SHA256) — carried forward from the earlier implementation, kept intact
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
pdv-python/pdv_kernel/
    tree.py                           ← add param extraction + ScriptParameter to PDVScript
    handlers/tree.py                  ← include params in NodeDescriptor for script nodes

electron/
    main/
        ipc.ts                        ← add files.pickExecutable IPC channel; add ScriptParameter +
        |                               params field to NodeDescriptor; add PDVApi files entry
        index.ts                      ← register files:pickExecutable ipcMain handler
    preload.ts                        ← add window.pdv.files.pickExecutable bridge
    renderer/src/
        app/index.tsx                 ← kernel status state, push subscriptions, dead code removal,
        |                               project save/load trigger handlers
        components/
            Tree/index.tsx            ← verify window.pdv.tree.list; driven by treeRefreshToken from App
            NamespaceView/index.tsx   ← verify window.pdv.namespace.query; accept disabled prop
            CommandBox/index.tsx      ← verify window.pdv.kernels.execute; accept disabled prop
            Console/index.tsx         ← verify execution result consumption
            EnvironmentSelector/index.tsx ← use window.pdv.files.pickExecutable for file picker
            ScriptDialog/index.tsx    ← full rewrite: use NodeDescriptor.params; build kernels.execute
        services/
            tree.ts                   ← verify new TreeNode shape; remove FileScanner assumptions
        types/
            pdv.d.ts                  ← add ScriptParameter type; update NodeDescriptor to include
                                        optional params field; all renderer types routed through here
```

### What is implemented

**`pdv-python`: PDVScript parameter extraction (`tree.py`, `handlers/tree.py`)**
- `PDVScript.__init__` inspects the script file's `run()` signature via `inspect.signature` at construction time. It extracts all parameters except the first (`pdv_tree`), producing a list of `ScriptParameter` dicts: `{ name, type, default, required }`. See ARCHITECTURE.md §5.7.
- If the file doesn't exist yet or has a syntax error, `params` defaults to `[]` — registration still succeeds.
- `handle_tree_list` in `handlers/tree.py` includes `params` in the node descriptor when `kind == 'script'`. Non-script nodes do not include a `params` field.

**IPC surface additions/removals (`ipc.ts`, `index.ts`, `preload.ts`)**
- `ScriptParameter` interface added to `ipc.ts`: `{ name: string; type: string; default: unknown; required: boolean }`.
- `NodeDescriptor.params` optional field added: `ScriptParameter[] | undefined`, present only when `type === 'script'`.
- `window.pdv.files.pickExecutable()` added: calls `dialog.showOpenDialog` in the main process, returns the selected file path as `string | null`. Used by both `EnvironmentSelector` and `SettingsDialog`.
- `window.pdv.script.run()` does NOT exist and must NOT be added. Running a `PDVScript` from the renderer is always done via `window.pdv.kernels.execute(kernelId, { code: 'pdv_tree["path.to.script"].run(a=1)' })`. The `ScriptDialog` component builds this string. This keeps the IPC surface minimal and makes script execution appear identically to user-typed code in the Console and kernel logs.
- `window.pdv.settings.onOpen()` does NOT exist and must NOT be added. Remove the stub call from `app/index.tsx`.

**Kernel startup and `kernelStatus` state (`app/index.tsx`)**
- Add `kernelStatus: 'idle' | 'starting' | 'ready' | 'error'` state (initially `'idle'`).
- `startKernel()` sets `'starting'` before `await window.pdv.kernels.start(spec)`, then `'ready'` on success or `'error'` on rejection. See ARCHITECTURE.md §4.4.
- All panels pass the locked state down: `Tree`, `NamespaceView`, and `CommandBox` all receive a `disabled` prop that is `true` when `kernelStatus !== 'ready'`. Disabled panels render a "Starting kernel…" overlay or are simply inert.
- On rejection, set `lastError` with the error message.

**Push subscriptions (`app/index.tsx`)**
- A single `useEffect` keyed on `currentKernelId` owns all push subscriptions. See ARCHITECTURE.md §11.4 for the canonical pattern.
- `window.pdv.tree.onChanged(...)` increments `treeRefreshToken`, propagated to `Tree` as a prop and triggering a re-fetch. This replaces the current behaviour where the token is only incremented manually after explicit user actions.
- `window.pdv.project.onLoaded(...)` repopulates command box tabs from the loaded project state.
- `useEffect` cleanup unsubscribes both; subscriptions are re-established when `currentKernelId` changes.

**Project Save / Open UI (`app/index.tsx`)**
- Two buttons added to the header: __Save Project__ and __Open Project__.
- __Save Project__: calls `dialog.showSaveDialog` (via a new `window.pdv.files.pickDirectory()` call, or inline using Electron's `showOpenDialog` with `properties: ['openDirectory', 'createDirectory']`) to select/confirm the save directory, then calls `window.pdv.project.save(saveDir, commandBoxes)`.
- __Open Project__: calls `dialog.showOpenDialog` (directory picker), then calls `window.pdv.project.load(saveDir)` and populates command box tabs from the result. The `pdv.project.onLoaded` push subscription then fires and refreshes the tree.
- Both buttons are disabled when `kernelStatus !== 'ready'`.
- `window.pdv.files.pickDirectory()` must be added to `ipc.ts`, `index.ts`, and `preload.ts` alongside `pickExecutable`. It wraps `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })` and returns `string | null`.

**ScriptDialog rewrite (`components/ScriptDialog/index.tsx`)**
- Remove the `window.pdv.script.getParams()` call and the `ScriptParameter` import from `../../../main/ipc`.
- The component now receives the `NodeDescriptor` (which contains `params`) as a prop instead of fetching params via IPC.
- On "Run", build the `kernels.execute` code string from the collected values:
  ```ts
  const args = Object.entries(values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  const code = `pdv_tree[${JSON.stringify(node.path)}].run(${args})`;
  await window.pdv.kernels.execute(kernelId, { code, capture: false });
  ```
- Log the generated code string to the Console so it's visible as user-runnable code.
- `handleTreeAction` in `app/index.tsx` must pass the `TreeNodeData` (which now includes `params` from `NodeDescriptor`) to `ScriptDialog`.

**Cross-boundary type imports (`types/pdv.d.ts`, all renderer files)**
- `ScriptParameter` and the updated `NodeDescriptor` type (with `params`) must be re-exported from `types/pdv.d.ts`.
- Renderer components must import shared types from `../types` or `../../types`, not from `../../../main/ipc` or `../../../../main/ipc`. Importing from `main/` crosses the process boundary in the type system and will break the TypeScript build once renderer and main have separate `tsconfig.json` roots.

### What is NOT changed in this step
- Visual layout and styling — no UX changes
- Component structure — only data flow is updated
- No new panels or dialogs are added

### Tests to confirm completion
There are no automated tests for the renderer in alpha. Confirmation is by manual smoke test:

1. Launch app (`npm run dev` or equivalent)
2. All panels (Tree, Namespace, CommandBox) show a loading/disabled state while the kernel is starting; the Save and Open buttons in the header are also disabled
3. App detects Python environment; if `pdv-python` is not installed, a prompt appears offering to install it; clicking "Browse" in either the environment selector or the Settings dialog opens a native file-picker dialog (`window.pdv.files.pickExecutable`)
4. Kernel starts; UI fully unlocks; Tree panel shows an empty tree at the working directory root
5. Typing `pdv_tree['x'] = 42` in the Command Box and running it causes the Tree panel to refresh **automatically** (via `pdv.tree.changed` push — NOT via a manual refresh button) and show node `x`
6. Namespace panel shows `pdv_tree` and `pdv` as protected names, plus `x`
7. Right-clicking a folder node and selecting "New Script" creates a script file; the created script file follows the template:
   ```python
   def run(pdv_tree: dict, ) -> dict:
       # add your code here
       return {}
   ```
8. Right-clicking the script node and selecting "Run" opens `ScriptDialog`, which reads `params` from the `NodeDescriptor` (no IPC round-trip). If the script has no extra params beyond `pdv_tree`, the dialog shows no form fields and only a Run button. Clicking Run constructs and executes `pdv_tree["<path>"].run()` via `kernels.execute`; the generated code string appears in the Console exactly as user-typed code would, and the return value is logged
9. Clicking __Save Project__ opens a directory picker; after selection, `project.json`, `tree-index.json`, and `command-boxes.json` are present in the chosen directory
10. Restart app; click __Open Project__ and select the saved directory; the `pdv.project.onLoaded` push fires; the Tree panel repopulates with node `x`; command box tabs are restored from `command-boxes.json`

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

## Step 9 — Historical Cleanup + OVERVIEW.md Overhaul

**Goal**: Final cleanup after the rewrite transition and a full rewrite of `OVERVIEW.md` so it reflects the current architecture and onboarding needs.

This step is primarily a cleanup and documentation pass, performed after Step 8 (tests green, TypeScript build clean).

---

### Part A — Historical directory cleanup

The old reference directory used during the rewrite has been removed.

Confirm that:
- Tests pass without importing from removed historical paths
- No import or require statement in `electron/` or `pdv-python/` references removed historical paths
- This document's briefing section no longer points to removed historical files

---

### Part B — Rewrite `OVERVIEW.md`

`OVERVIEW.md` should be rewritten from scratch so it:

1. **Describes the current system** — the three-process Electron model, PDV comm protocol, `pdv-python`, Tree authority model, and IPC surface
2. **Serves as an entry point for new contributors** — clear "what/why" framing with pointers to authoritative detail
3. **Does not duplicate `ARCHITECTURE.md`** — summary/orientation only; formal specification remains in `ARCHITECTURE.md`

#### Required sections

- **What PDV is**
- **Process model** (with ASCII diagram)
- **The PDV comm protocol**
- **The Tree**
- **`pdv-python` package**
- **Renderer UI components**
- **Developer setup**
- **Key design decisions before touching code**
- **Pointer map**

#### Tone

Write it like a high-signal project README that a competent software engineer can read in 10 minutes and quickly understand.

---

### Tests to confirm completion

There are no automated tests for this step. Completion criteria:

- Removed historical directory is absent from the repository
- No import or runtime reference to removed historical paths in active code
- `OVERVIEW.md` no longer carries the historical warning banner
- `OVERVIEW.md` accurately describes the post-Step-8 system

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
                                                            └─► Step 9 (historical cleanup + OVERVIEW.md)
```

Steps 1 and 2 produce a standalone Python package with no Electron dependency.  
Steps 3 and 4 produce a standalone Electron module with no renderer dependency.  
Step 5 is the first step where the Python package and Electron module must work together.  
Step 7 is the first step where a human must look at the running UI to confirm correctness.
