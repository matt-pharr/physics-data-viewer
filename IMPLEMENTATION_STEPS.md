# Implementation Steps (Agent-Friendly Prompts)

Use these prompts one step at a time. Each step is intended to be completable in a single agent session.  Keep diffs small and run tests where possible.  Each step includes context, deliverables, and exit criteria.

---

## Step 0: Repo setup & tooling

**Context:**  
We are building a React + Vite + Electron app.  The Electron main process lives in `electron/main/`, the preload in `electron/preload.ts`, and the React renderer in `electron/renderer/`. We use TypeScript throughout, Vitest for testing, and will eventually use Monaco for code editing.

**Prompt:**  
Set up the project scaffolding: 
- Create `electron/package.json` with: 
  - Scripts:  `dev`, `dev:main`, `dev:renderer`, `build`, `build:renderer`, `build:main`, `test`, `lint` (placeholder).
  - Dependencies: react, react-dom. 
  - DevDependencies: electron, electronmon, vite, @vitejs/plugin-react, typescript, vitest, concurrently, cross-env, @types/node, @types/react, @types/react-dom. 
- Create `electron/tsconfig.json` for main process (CommonJS, outDir dist, include main/**/*.ts and preload. ts).
- Create `electron/renderer/tsconfig.json` for renderer (ESNext, jsx react-jsx).
- Create `electron/renderer/vite.config.ts` with React plugin, port 5173, outDir dist.
- Create `electron/renderer/index.html` with a root div and script src to main.tsx.
- Create `.gitignore` (node_modules, dist, . vite, .DS_Store, *.log).
- Add a trivial vitest test file `electron/main/app. test.ts` that passes.

**Deliverables:**
- `electron/package.json`
- `electron/tsconfig.json`
- `electron/renderer/tsconfig.json`
- `electron/renderer/vite.config. ts`
- `electron/renderer/index.html`
- `.gitignore`
- `electron/main/app.test.ts`

**Exit criteria:**
- `cd electron && npm install` succeeds.
- `npm run build` compiles without errors.
- `npm run test` runs and the trivial test passes. 

---

## Step 1: Electron + Vite shell

**Context:**  
We need a runnable Electron app that loads a React renderer. In dev mode, the renderer is served by Vite at localhost:5173. In prod, it loads from the built dist folder.

**Prompt:**  
Implement the Electron shell:
- Create `electron/main/app.ts`:
  - Import `./index` (for IPC handler registration, even if empty).
  - Create BrowserWindow (1280x800), contextIsolation true, preload path.
  - In dev (NODE_ENV=development), load `http://localhost:5173` and open devtools.
  - In prod, load `renderer/dist/index.html`.
  - Handle `window-all-closed` and `activate` events.
- Create `electron/main/index.ts` as an empty file (will hold IPC handlers).
- Create `electron/preload.ts` as a minimal stub (just an empty contextBridge for now).
- Create `electron/renderer/src/main.tsx` that renders `<App />` into root. 
- Create `electron/renderer/src/app/index.tsx` with a placeholder layout: 
  - Left pane: "Tree (stub)"
  - Right-top: "Console (stub)"
  - Right-bottom: "Command Box (stub)"
  - Bottom: "Status Bar (stub)"
  - Use CSS grid, dark background (#1e1e1e), borders (#333).
- Create `electron/renderer/src/styles/index.css` with base dark theme styles.

**Deliverables:**
- `electron/main/app.ts`
- `electron/main/index.ts`
- `electron/preload.ts`
- `electron/renderer/src/main.tsx`
- `electron/renderer/src/app/index.tsx`
- `electron/renderer/src/styles/index.css`

**Exit criteria:**
- `npm run dev` opens an Electron window showing the placeholder layout.
- No console errors. 

---

## Step 2: IPC contracts

**Context:**  
The main process and renderer communicate via IPC. We define typed contracts so both sides stay in sync.  The preload exposes a safe `window. pdv` API. 

**Prompt:**  
Define IPC contracts and wire the preload:
- Create `electron/main/ipc.ts` with:
  - `IPC` object containing channel names for kernels (list/start/stop/execute/interrupt/restart/complete/inspect), tree (list/get/save), files (read/write), config (get/set).
  - Types:  `KernelExecuteRequest`, `KernelExecuteResult`, `TreeNode` (see PLAN.md for shapes).
- Update `electron/preload.ts`:
  - Import IPC channels and types.
  - Create `api` object with typed methods using `ipcRenderer.invoke`.
  - Expose via `contextBridge. exposeInMainWorld('pdv', api)`.
  - Add global `Window` interface extension for `pdv`.

**Deliverables:**
- `electron/main/ipc.ts`
- Updated `electron/preload.ts`

**Exit criteria:**
- TypeScript compiles. 
- `window.pdv` is typed and available in renderer (can verify with a console.log in App).

---

## Step 3: Kernel manager (stub)

**Context:**  
The kernel manager handles starting/stopping/executing Jupyter kernels. For now, we stub it so the UI can be built without real kernels.  Later we'll integrate `@jupyterlab/services`.

**Prompt:**  
Create the kernel manager and wire IPC handlers:
- Create `electron/main/kernel-manager.ts`:
  - Export a `KernelManager` class with async methods:  `list()`, `start(spec?)`, `stop(id)`, `execute(id, req)`, `interrupt(id)`, `restart(id)`, `complete(id, code, pos)`, `inspect(id, code, pos)`.
  - All methods return stub data (e.g., execute returns `{ stdout: 'Hello from stub', result: 42 }`).
- Update `electron/main/index.ts`:
  - Import `ipcMain` from electron, `IPC` from ipc.ts, `KernelManager` from kernel-manager.ts.
  - Instantiate KernelManager. 
  - Register `ipcMain. handle` for all kernel channels, delegating to the manager.
- Create placeholder init cell files: 
  - `electron/main/init/python-init.py` with a comment describing future MPL backend setup and `pdv_show` helper.
  - `electron/main/init/julia-init.jl` with a comment describing future GR/Makie setup and `pdv_show` helper.

**Deliverables:**
- `electron/main/kernel-manager.ts`
- Updated `electron/main/index.ts`
- `electron/main/init/python-init.py`
- `electron/main/init/julia-init.jl`

**Exit criteria:**
- App still runs. 
- Calling `window.pdv.kernels.execute('stub', { code: '1+1' })` from devtools returns stub data.

---

## Step 4: Renderer shell with Monaco command box

**Context:**  
The command box is where users type code. It must use Monaco editor. We also need a console/log area to display execution history.

**Prompt:**  
Build the console and command box components:
- Add `monaco-editor` and `@monaco-editor/react` to dependencies.
- Create `electron/renderer/src/components/Console/index.tsx`:
  - Accept a `logs` prop: array of `{ id, timestamp, code, stdout?, stderr?, error?, duration? }`.
  - Render a scrollable list of log entries with timestamp, code snippet, stdout/stderr/error, duration. 
  - Include a "Clear" button that calls a callback prop.
  - Style with dark theme. 
- Create `electron/renderer/src/components/CommandBox/index.tsx`:
  - Use `@monaco-editor/react` to render a Monaco editor.
  - Support tabs (array of `{ id, label, code }`) with add/remove. 
  - "Execute" button that calls `window.pdv.kernels. execute` with the current code.
  - "Clear" button to clear the editor.
  - Show inline error bar if last execution had an error.
  - Show execution duration after run.
  - Dark theme for Monaco (`vs-dark`).
- Create `electron/renderer/src/components/StatusBar/index.tsx`:
  - Display:  kernel status (prop), env name, cwd, plot mode (Native/Capture toggle), last exec duration. 
- Update `electron/renderer/src/app/index.tsx`:
  - Add state for logs, tabs, kernel status, plot mode. 
  - Wire Console and CommandBox components. 
  - On execute:  call IPC, append to logs, update status. 

**Deliverables:**
- Updated `electron/package.json` with monaco dependencies.
- `electron/renderer/src/components/Console/index. tsx`
- `electron/renderer/src/components/CommandBox/index.tsx`
- `electron/renderer/src/components/StatusBar/index.tsx`
- Updated `electron/renderer/src/app/index.tsx`

**Exit criteria:**
- Monaco editor renders in the command box area.
- Clicking "Execute" calls the stub kernel and appends a log entry.
- Status bar shows kernel status and plot mode toggle.

---

## Step 5: Tree POC (stub data)

**Context:**  
The Tree is the central UI for browsing data. It must be virtualized, lazy-loaded, with expand/collapse. For now, we use stub data.

**Prompt:**  
Build the Tree component with stub data:
- Create `electron/renderer/src/services/tree.ts`:
  - Export `listTree(path:  string): Promise<TreeNode[]>` that returns stub nodes.
  - Root should have a few children with different types (folder, ndarray, dataframe, image, unknown).
  - Some nodes should have `hasChildren: true`.
- Create `electron/renderer/src/components/Tree/index.tsx`:
  - Render a virtualized tree (can use a simple implementation or `react-window`).
  - Columns: Key, Type, Preview; sticky header. 
  - Expand/collapse on arrow click; fetch children on expand via `listTree`.
  - Double-click logs the node (placeholder action).
  - Context menu (right-click) showing "View", "Plot", "Delete" (all no-op for now).
  - Show loading spinner while fetching children.
- Add tabs above tree:  Namespace | Tree | Modules (only Tree is functional; others show "Coming soon").
- Update `electron/renderer/src/app/index. tsx` to include the Tree component in the left pane.

**Deliverables:**
- `electron/renderer/src/services/tree.ts`
- `electron/renderer/src/components/Tree/index. tsx`
- Updated `electron/renderer/src/app/index.tsx`

**Exit criteria:**
- Tree renders stub data.
- Expanding a node fetches and shows children.
- Double-click logs to console. 
- Context menu appears on right-click.

---

## Step 6: Plot mode toggle (plumbing)

**Context:**  
Users can choose between native plot windows and inline capture. This step wires the toggle and passes the flag through execution.

**Prompt:**  
Wire plot mode toggle:
- In `StatusBar`, make the plot mode toggle functional (Native/Capture).
- Store plot mode in app state.
- Pass `capture` flag in `KernelExecuteRequest` when executing.
- Update `electron/main/init/python-init.py`:
  - Add comments and placeholder code for setting MPL backend based on capture mode.
  - Define a stub `pdv_show()` function that would capture the current figure.
- Update `electron/main/init/julia-init.jl`:
  - Add comments for GR/Makie backend selection.
  - Define a stub `pdv_show()` function.

**Deliverables:**
- Updated StatusBar with functional toggle.
- Updated app state and execute call.
- Updated init files with placeholder logic.

**Exit criteria:**
- Toggle changes state.
- Execute payload includes `capture` flag (verify in stub kernel console. log or test).

---

## Step 7: Data loader registry (stub)

**Context:**  
Different file types need different loaders (HDF5, Zarr, Parquet, etc.). We create a registry that picks the right loader by extension/type.

**Prompt:**  
Create the loader registry:
- Create `electron/main/file-service.ts`:
  - Define a `Loader` interface:  `{ canLoad(path: string, type?:  string): boolean; getMetadata(path: string): Promise<{ shape?, dtype?, size? }>; getSlice(path: string, opts? ): Promise<ArrayBuffer | string> }`.
  - Create stub loaders for:  hdf5, zarr, parquet, arrow, npy, image, text. 
  - Create a `LoaderRegistry` class that registers loaders and picks the right one by extension.
  - Export a singleton `loaderRegistry`.
- Wire IPC handlers for `files:read` in `electron/main/index.ts` that use the registry.
- Update `TreeNode` type to include `loaderHint?:  string`.

**Deliverables:**
- `electron/main/file-service.ts`
- Updated `electron/main/index.ts` with files handlers.
- Updated `TreeNode` type in `ipc.ts`.

**Exit criteria:**
- Registry unit test:  correct loader selected for `.h5`, `.zarr`, `.parquet`, `.npy`, `.png`.
- IPC `files:read` returns stub metadata.

---

## Step 8: Blob store (stub)

**Context:**  
Arbitrary objects (pickles, JLSO) are stored in a content-addressed blob store. Trust gating prevents loading untrusted blobs.

**Prompt:**  
Create the blob store:
- Create `electron/main/blob-store.ts`:
  - `put(data: Buffer): Promise<string>` — hash with sha256, store in memory map, return hash.
  - `get(hash: string, trusted?: boolean): Promise<Buffer>` — if not trusted and type is pickle/JLSO, throw or return null.
  - `has(hash: string): boolean`.
  - In-memory Map for now; later can persist to disk.
- Wire IPC handlers for `tree:save` and `tree:get` to use blob store for unknown types. 

**Deliverables:**
- `electron/main/blob-store.ts`
- Updated `electron/main/index.ts` with tree handlers using blob store. 

**Exit criteria:**
- Unit test: put/get round-trip; trust gate blocks untrusted pickle. 

---

## Step 9: Module manifests & actions (stub)

**Context:**  
Modules can register custom actions for specific types/paths. The action registry determines what happens on double-click or context menu.

**Prompt:**  
Create the action registry: 
- Create `electron/renderer/src/services/actions.ts`:
  - Define `Action` interface: `{ id: string; label: string; match: { type?:  string; path?: RegExp }; handler: (node: TreeNode) => void }`.
  - Create `ActionRegistry` class: `register(action)`, `getActions(node): Action[]`, `getPrimaryAction(node): Action | null`.
  - Register default actions: "View" for all, "Plot" for ndarray/dataframe, "Open" for files. 
- Update Tree component: 
  - On double-click, call primary action handler.
  - Context menu shows all matching actions.
- Create `electron/renderer/src/manifests/` folder with a sample `sample-module.json` manifest (just for reference structure).

**Deliverables:**
- `electron/renderer/src/services/actions.ts`
- Updated Tree component. 
- `electron/renderer/src/manifests/sample-module.json`

**Exit criteria:**
- Double-click triggers primary action (e.g., logs "View" action).
- Context menu shows available actions. 
- Registry unit test: correct actions for different node types.

---

## Step 10: Namespace/Project UX & full status bar

**Context:**  
The Namespace tab shows kernel variables; Modules tab shows loaded modules.  The status bar shows full runtime info.

**Prompt:**  
Complete the UX:
- Create `electron/renderer/src/components/NamespaceView/index.tsx`:
  - Stub:  show "Namespace variables will appear here" or a mock list.
- Create `electron/renderer/src/components/ModulesView/index.tsx`:
  - Stub: show "Loaded modules will appear here" or a mock list.
- Update the tabs (Namespace | Tree | Modules) to render the correct component.
- Update StatusBar: 
  - Show kernel status with colored dot (green=idle, yellow=busy, red=disconnected).
  - Show env name (stub:  "python3").
  - Show cwd (stub: "~/projects").
  - Show plot mode. 
  - Show last exec duration.
- Create `electron/main/config.ts`:
  - Simple config store:  `get(): Config`, `set(cfg:  Partial<Config>)`.
  - Config includes: `kernelSpec`, `plotMode`, `cwd`, `trusted`.
- Wire IPC handlers for `config:get` and `config:set`.

**Deliverables:**
- `electron/renderer/src/components/NamespaceView/index.tsx`
- `electron/renderer/src/components/ModulesView/index.tsx`
- Updated tab switching in app. 
- Updated StatusBar. 
- `electron/main/config.ts`
- Updated `electron/main/index.ts` with config handlers.

**Exit criteria:**
- Tabs switch views. 
- Status bar shows all info.
- Config get/set works via IPC.

---

## Step 11: Packaging & first-run flow (stub)

**Context:**  
The app should be packageable with electron-builder. First-run shows an environment selector.

**Prompt:**  
Set up packaging:
- Add electron-builder config to `electron/package.json` (or create `electron-builder.yml`):
  - AppId, productName, directories, targets for mac/win/linux.
- Create `electron/renderer/src/components/FirstRunDialog/index.tsx`:
  - Modal dialog asking user to select a kernel/env. 
  - Stub: dropdown with "Python 3", "Julia 1.9", "Custom... ".
  - "Continue" button that saves selection to config and closes dialog.
- Update app to show FirstRunDialog if config has no kernelSpec set. 

**Deliverables:**
- electron-builder config. 
- `electron/renderer/src/components/FirstRunDialog/index.tsx`
- Updated app to show dialog on first run.

**Exit criteria:**
- `npm run build` produces a packaged app (or at least compiles).
- First-run dialog appears when config is empty.

---

## Step 12: Polish & documentation

**Context:**  
Final polish:  documentation, cleanup, and sample manifests. 

**Prompt:**  
Finalize the project:
- Create `README.md`:
  - Project overview (link to PLAN.md).
  - Quickstart:  clone, `cd electron`, `npm install`, `npm run dev`.
  - Architecture overview.
  - How to add loaders, actions, init cells.
- Create `electron/renderer/src/manifests/defaults.json`:
  - Default actions for common types (ndarray, dataframe, image, text, folder).
- Ensure all files have appropriate comments. 
- Run `npm run lint` and `npm run test`; fix any issues. 

**Deliverables:**
- `README.md`
- `electron/renderer/src/manifests/defaults.json`
- All tests passing, lint clean.

**Exit criteria:**
- README is complete. 
- `npm run build` succeeds.
- `npm run test` passes.
- App runs and all stub features work.

---

## Notes for Agents

- **Keep IPC types consistent** across main/preload/renderer.  Reference `ipc.ts` often.
- **Do not expose Node APIs to renderer**; only the typed bridge (`window.pdv`).
- **Keep diffs small**; commit after each step.
- **Run `npm run build` and `npm run test`** after each step to catch errors early.
- **Monaco is required** for the command box; ensure it renders correctly.
- **If kernels are unavailable**, keep kernel-manager stubbed and skip integration tests.
- **Trust-gate pickle/JLSO loads**; always check the trust flag.
- **Use dark theme** consistently (#1e1e1e background, #333 borders, #4ec9b0 accent).