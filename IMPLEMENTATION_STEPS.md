# Implementation Steps (Agent-Friendly Prompts)

Use these prompts one step at a time.  Each step is intended to be completable in a single agent session.  Keep diffs small and run tests where possible.  Each step includes context, deliverables, and exit criteria.

---

## Step 0: Repo setup & tooling ✅ COMPLETE

**Context:**  
We are building a React + Vite + Electron app.  The Electron main process lives in `electron/main/`, the preload in `electron/preload.ts`, and the React renderer in `electron/renderer/`. We use TypeScript throughout, Vitest for testing, and will eventually use Monaco for code editing.

**Deliverables:**
- Project scaffolding with `electron/` directory
- `package.json` with scripts and dependencies
- TypeScript configurations for main and renderer
- Vite config for renderer
- Basic `.gitignore`
- Trivial passing test

**Exit criteria:**
- `npm install` succeeds
- `npm run build` compiles without errors
- `npm run test` passes

---

## Step 1: Electron + Vite shell ✅ COMPLETE

**Context:**  
We need a runnable Electron app that loads a React renderer. In dev mode, the renderer is served by Vite at localhost:5173. In prod, it loads from the built dist folder.

**Deliverables:**
- Electron main process with BrowserWindow
- Minimal preload script
- React renderer with placeholder layout
- Dark theme styling

**Exit criteria:**
- `npm run dev` opens Electron window with placeholder UI
- No console errors

---

## Step 2: IPC contracts ✅ COMPLETE

**Context:**  
The main process and renderer communicate via IPC. We define typed contracts so both sides stay in sync.  The preload exposes a safe `window.pdv` API.

**Deliverables:**
- `electron/main/ipc.ts` with channel names and TypeScript types
- `electron/preload.ts` exposing typed `window.pdv` API
- Type declarations for renderer

**Exit criteria:**
- TypeScript compiles
- `window.pdv` is typed and available in renderer
- IPC calls return stub data

---

## Step 3: Kernel manager (stub) ✅ COMPLETE

**Context:**  
The kernel manager handles starting/stopping/executing Jupyter kernels. For Step 3, we stub it so the UI can be built without real kernels.  Real integration comes in Step 5.5.

**Deliverables:**
- `KernelManager` class with stub methods
- IPC handlers wired to KernelManager
- Init cell placeholder files (Python/Julia)
- Unit tests for KernelManager

**Exit criteria:**
- IPC kernel calls return stub data
- Tests pass
- Init cells exist

---

## Step 4: Renderer Console & Monaco Command Box ✅ COMPLETE

**Context:**  
The Console displays execution history.  The CommandBox uses Monaco editor for code input. Both wire to the stub kernel via IPC.

**Deliverables:**
- Console component displaying log entries
- CommandBox component with Monaco editor
- Multiple command tabs
- Execute button and keyboard shortcuts
- Inline error display

**Exit criteria:**
- Monaco editor renders and accepts code
- Execute button sends code to kernel
- Console displays results (stdout, stderr, result, errors)
- Tabs work
- Ctrl/Cmd+Enter executes code

---

## Step 5: Tree POC (lazy metadata) ✅ COMPLETE

**Context:**  
The Tree is the central UI for browsing data. It must be virtualized, lazy-loaded, with expand/collapse.  For now, we use stub data from IPC.

**Deliverables:**
- Tree component with virtualized rendering
- TreeNodeRow component with expand/collapse
- Context menu with stub actions
- Tree service with caching
- Type icons and badges

**Exit criteria:**
- Tree displays stub nodes
- Expand/collapse works
- Double-click logs to console
- Right-click shows context menu
- Visual polish (hover effects, icons, etc.)

---

## Step 5.5: Real Kernel Integration + Environment Selector 🔄 IN PROGRESS

**Context:**  
Replace stub KernelManager with real Jupyter integration using `@jupyterlab/services`. Add GUI for users to configure Python/Julia executable paths.

**Deliverables:**
- Real KernelManager using `@jupyterlab/services`
- Environment selector dialog for configuring executables
- Executable validation
- Config persistence for executable paths
- Real code execution with actual Python/Julia interpreters

**Exit criteria:**
- Real Python code executes and returns actual results
- Variables persist across executions
- Errors handled correctly
- Completions work
- Environment selector appears on first run
- Config persists across sessions

---

## Step 6: Plot Mode & Capture Integration

**Context:**  
Users need control over plot behavior:  native windows (default) or inline capture. This requires configuring matplotlib/Plots.jl backends and handling image display_data.

**Goals:**
- Wire plot mode toggle (Native vs Capture) to kernel execution
- Update Python init cell to configure matplotlib backend based on mode
- Update Julia init cell for Plots.jl backend configuration
- Implement `pdv_show()` helper functions properly
- Handle `display_data` messages with images in KernelManager
- Render captured images in Console component
- Test both modes with real matplotlib/Plots.jl code

**Deliverables:**
- Updated Python init cell with backend configuration
- Updated Julia init cell with backend configuration
- `pdv_show()` implementation for both languages
- Image rendering in Console
- Plot mode toggle functional in UI

**Exit criteria:**
- Native mode: `plt.show()` opens external window
- Capture mode: `plt.show()` returns image to console
- `pdv_show()` works in both languages
- Images display inline in Console
- Toggle persists in config

---

## Step 7: Namespace View

**Context:**  
Users need to see what variables exist in their kernel's memory. The Namespace tab should show kernel variables in a tree-like structure.

**Goals:**
- Query kernel for current namespace (`dir()` / `names(Main)`)
- Display variables in tree structure (name, type, shape, preview)
- Refresh button to re-query namespace
- Auto-refresh option (poll every N seconds)
- Double-click variable to inspect or plot
- Integration with existing Tree component architecture

**Deliverables:**
- Namespace querying via kernel execution
- Namespace tab populated with variables
- Variable metadata extraction (type, shape, size, preview)
- Refresh and auto-refresh functionality
- Context menu actions for variables

**Exit criteria:**
- Namespace tab shows kernel variables after execution
- Variables display type, shape, and preview
- Refresh updates the list
- Double-click on ndarray/dataframe shows preview
- Auto-refresh option works

---

## Step 8: Script Execution & File Operations

**Context:**  
Users need to run Python/Julia scripts from files, not just command boxes. Scripts should be normal files editable in external IDEs without warnings.  Scripts live in `tree/scripts/` and have a standard `run(tree, **kwargs)` entry point.

**Goals:**
- Define script structure: `run(tree, **kwargs)` as entry point
- Scan `tree/scripts/` directory for `.py`/`.jl` files
- Create script tree nodes with metadata
- Implement `tree.run_script(path, **kwargs)` in kernel
- Right-click → "Edit" opens script in external editor (configurable)
- Right-click → "Run" executes script with parameter dialog
- Implement reload (importlib.reload / Revise. jl)
- Hot reload:  detect file changes, offer to re-run

**Deliverables:**
- Script scanning and tree node creation
- `PDVTree. run_script()` implementation
- External editor integration (configurable edit command)
- Script parameter dialog (if script has type hints)
- Reload functionality
- File watcher for external edits

**Exit criteria:**
- Scripts appear in Tree under `scripts/`
- Double-click script opens parameter dialog → executes
- Right-click → Edit opens in VS Code/nvim/etc.
- Script can access `tree` and manipulate data
- Changes to script file detected and offer reload
- No IDE warnings in script files (clean `run()` signature)

---

## Step 9: Data Loaders (HDF5/Zarr/Parquet/NPY)

**Context:**  
Users need to browse and load scientific data files. Loaders extract metadata (shape, dtype) without loading full data.  Data files live in `tree/data/` and appear in Tree.

**Goals:**
- Implement loaders for common formats: 
  - HDF5 (h5py) - groups, datasets, attributes, lazy chunked reads
  - Zarr - array metadata, chunked reads
  - Parquet/Arrow - schema, paged reads
  - NumPy . npy - memmap support
  - Images (PNG/JPG) - PIL/Pillow for dimensions
- Scan `tree/data/` directory for data files
- Extract metadata (shape, dtype, size, preview)
- Expandable tree nodes (HDF5 groups, Zarr hierarchy)
- Double-click to load into kernel namespace
- Preview data in Tree (first N elements)

**Deliverables:**
- Loader registry and interface
- HDF5 loader (metadata + lazy reads)
- Zarr loader (metadata + lazy reads)
- Parquet/Arrow loader (schema + paged reads)
- NPY loader (memmap)
- Image loader (dimensions, thumbnail preview)
- File scanner that detects and categorizes files
- Tree integration showing file hierarchy
- Load-to-namespace functionality

**Exit criteria:**
- HDF5 files appear in Tree, expandable to show groups/datasets
- Double-click dataset loads into kernel (lazy, not full file)
- Zarr arrays show metadata and are loadable
- Parquet files show schema and row count
- `.npy` files load via memmap for large arrays
- Images show preview thumbnail in Tree
- Preview shows first 10 elements/rows

---

## Step 10:  Arbitrary Object Store & Project Persistence

**Context:**  
Users need to save arbitrary Python/Julia objects to the Tree (not just standard formats). We need a blob store (content-addressed by hash) and project save/load functionality.  Project structure mirrors file system. 

**Goals:**
- Implement blob store (content-addressed, SHA256 hash)
- Serialize Python objects with pickle (trust-gated)
- Serialize Julia objects with JLSO/JLD2
- Store blobs in `blobs/` directory, metadata in tree
- IPC:  `tree.save(path, object)` from kernel
- IPC: `tree.load(path)` back to kernel
- Trust flag UI (warn on loading untrusted pickles)
- Define `project.pdv` schema (JSON manifest)
- Implement save/load project
- File watcher for external edits to scripts/data
- Auto-save mechanism (every 30s)
- Recovery from crash

**Deliverables:**
- Blob store implementation (put/get by hash)
- Pickle/JLSO serialization with trust checks
- `tree.save()` and `tree.load()` kernel API
- Project manifest schema (`project.pdv`)
- Save/load project IPC handlers
- Auto-save with unsaved changes indicator
- File watcher for external changes
- Crash recovery dialog

**Exit criteria:**
- Can save arbitrary Python object:  `tree['results']['my_obj'] = complex_object`
- Object serialized to `blobs/<hash>. pickle`
- Reloading project restores object
- Trust warning appears for unknown pickles
- Ctrl/Cmd+S saves project
- Auto-save runs every 30s
- External script edit detected, offers reload
- Crash recovery dialog on restart

---

## Step 11: Module Manifests & Dynamic UIs (Phase 1 - Basic)

**Context:**  
Users (module developers) should be able to create custom GUIs for their analysis workflows using declarative JSON manifests. No JavaScript required.  Phase 1 covers basic widgets and architecture.

**Goals:**
- Define manifest schema (JSON) for module panels
- Basic widget types: 
  - `number_input`, `text_input`, `checkbox`, `dropdown`, `slider`
  - `button` (with action:  method call or inline script)
  - `output` (text display)
  - `divider`, `spacer`, `group` (layout)
- Module registration:  `pdv.register_module(id, manifest)` in kernel
- IPC: `modules.register(manifest)`, `modules.execute(id, action, args)`
- Dynamic widget renderer in frontend (React components)
- Button actions call kernel methods or execute inline scripts
- "Modules" tab shows registered modules as panels
- Example module included (e.g., "Data Smoothing")

**Deliverables:**
- Manifest schema definition (JSON schema)
- Module registration IPC handlers
- Dynamic widget renderer (interprets manifest → React components)
- Basic widget components (input, button, output, etc.)
- Module panel container with tabs
- Example module:  simple analysis with parameters + Run button
- Documentation for module developers (manifest reference)

**Exit criteria:**
- Can register module from kernel: `pdv.register_module('smooth', manifest)`
- Module appears in "Modules" tab
- Number input, text input, checkbox, dropdown all render
- Button click calls Python method with widget values as args
- Output widget displays returned value
- Example module runs successfully
- Manifest schema documented

---

## Step 12: Module Manifests & Dynamic UIs (Phase 2 - Advanced)

**Context:**  
Phase 1 established basic widgets. Phase 2 adds advanced widgets for real-world workflows:  tree selectors, code input, plot areas, tables, progress bars, etc.

**Goals:**
- Advanced widget types:
  - `tree_selector` (pick data from Tree, with filters)
  - `code_input` (Monaco editor for inline code)
  - `plot_area` (display plots from variables)
  - `table_output` (render dataframes/arrays as tables)
  - `progress` (progress bar linked to variable)
  - `log_viewer` (scrolling log output)
  - `tabs`, `accordion` (nested layouts)
- Widget state binding (`bind_to:  "self. attribute"`)
- Event callbacks (`on_change` triggers Python method)
- Reactive widget queries (`gui.get_widget_value()` from Python)
- Conditional visibility/enable (`visible_if`, `enabled_if`)
- Complete example modules (2-3 real-world examples)

**Deliverables:**
- Tree selector widget (filters by type, path)
- Code input widget (Monaco, language-aware)
- Plot area widget (renders matplotlib figures)
- Table output widget (paginated, sortable)
- Progress bar widget (polls variable)
- Log viewer widget (auto-scroll, filter)
- Advanced layout widgets (tabs, accordion)
- State binding implementation
- Event callback system
- Example modules:  fitting, visualization, batch processing

**Exit criteria:**
- Tree selector shows filterable tree, returns path
- Code input (Monaco) editable, returns code string
- Plot area displays matplotlib figure from kernel variable
- Table output renders dataframe with pagination
- Progress bar updates as Python variable changes
- Module with tree selector + button + plot works end-to-end
- 3 complete example modules included
- Widget reference documentation complete

---

## Step 13: Packaging & Distribution

**Context:**  
Prepare app for distribution to end users. Build installers for macOS, Windows, Linux. 

**Goals:**
- electron-builder configuration
- Build scripts for all platforms
- App icon and branding
- Code signing (macOS)
- Auto-updater setup (optional)
- Installer/DMG/AppImage creation
- First-run experience polish
- Error reporting/logging for production

**Deliverables:**
- `electron-builder.yml` or package.json config
- Build scripts (`npm run dist: mac`, `dist:win`, `dist:linux`)
- App icon (1024x1024 + all sizes)
- Code signing certificate setup (docs)
- Installers for all platforms
- First-run tutorial/welcome screen
- Error logging to file

**Exit criteria:**
- `npm run dist:mac` produces . dmg installer
- `npm run dist:win` produces .exe installer
- `npm run dist:linux` produces AppImage
- App installs and runs on clean system
- First-run wizard guides new users
- Errors logged to `~/Library/Logs/physics-data-viewer/` (or equivalent)

---

## Step 14: Documentation & Polish

**Context:**  
Final step before release. Make the app usable by others with comprehensive documentation. 

**Goals:**
- User guide (quickstart, tutorials, common workflows)
- Developer guide (adding loaders, creating modules, manifest reference)
- API reference (IPC methods, tree API, module manifest schema)
- Example workflows/projects (starter templates)
- Default module manifests for common tasks
- Error handling polish (user-friendly error messages)
- Keyboard shortcuts reference
- Help menu with links to docs

**Deliverables:**
- `docs/user-guide/` (Markdown or website)
- `docs/developer-guide/`
- `docs/api-reference/`
- Example projects in `examples/`
- Default modules in `modules/`
- Help menu in app (links to docs)
- Keyboard shortcuts overlay (press `?`)
- Improved error messages throughout

**Exit criteria:**
- User guide covers:  installation, first project, running scripts, loading data, creating modules
- Developer guide covers: loader API, module manifest schema, script conventions
- API reference documents all IPC methods and types
- 3+ example projects included
- Help menu functional
- Keyboard shortcuts documented and discoverable
- Error messages are actionable (not stack traces)

---

## Summary:  What Each Step Delivers

| Step | Feature | Status |
|------|---------|--------|
| 0 | Project scaffolding | ✅ Complete |
| 1 | Electron + React shell | ✅ Complete |
| 2 | IPC contracts | ✅ Complete |
| 3 | Kernel manager (stub) | ✅ Complete |
| 4 | Console + Monaco CommandBox | ✅ Complete |
| 5 | Tree with lazy loading | ✅ Complete |
| 5.5 | Real Jupyter kernels + env selector | 🔄 In Progress |
| 6 | Plot mode (native/capture) | ⏳ Next |
| 7 | Namespace view | ⏳ |
| 8 | Script execution & external editing | ⏳ |
| 9 | Data loaders (HDF5, Zarr, etc.) | ⏳ |
| 10 | Object store + project persistence | ⏳ |
| 11 | Module manifests (basic widgets) | ⏳ |
| 12 | Module manifests (advanced widgets) | ⏳ |
| 13 | Packaging & distribution | ⏳ |
| 14 | Documentation & polish | ⏳ |

---

## Notes for Agents

- Keep IPC types consistent across main/preload/renderer. 
- Do not expose Node APIs to renderer; only the typed bridge (`window.pdv`).
- Keep diffs small; commit after each step.
- Run `npm run build` and `npm run test` after each step to catch errors early.
- If kernels are unavailable, keep kernel-manager stubbed and skip integration tests.
- Trust-gate pickle/JLSO loads; always check the trust flag. 
- Use dark theme consistently (#1e1e1e background, #333 borders, #4ec9b0 accent).