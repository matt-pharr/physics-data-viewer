# PDV Planned Features

This document describes all features planned beyond the initial alpha release of PDV, organized by release milestone.

## Release milestones

| Release | Description |
|---|---|
| **0.0.2-alpha2** | Completion of the backend refactor described in [`IMPLEMENTATION_STEPS.md`](IMPLEMENTATION_STEPS.md). Core architecture (PDV comm protocol, tree authority model, project save/load, IPC surface) is in place and all tests pass. This is the baseline from which all features below are additive. |
| **0.1.0-beta1** | All Alpha Features (items 1–10 below) are implemented and stable. The application is suitable for active scientific use. |
| **1.0.0** | All Beta Features (B1–B10 below, plus any added during beta) are implemented. The application is suitable for broad community distribution. |

The alpha architecture is specified in [`ARCHITECTURE.md`](ARCHITECTURE.md). Everything in this document is additive to that foundation.

---

# Alpha Features (Target: 0.1.0-beta1)

---

## 1) Advanced Lazy Loading for Large Data

### Goal
The alpha architecture includes a lazy-load registry that defers loading of file-backed tree nodes until they are accessed (ARCHITECTURE.md §5.8, §6.3). This handles the common case — a node backed by a `.npy` or `.parquet` file is loaded fully into memory on first access. For target users working with datasets in the 100GB+ range, full materialization is not feasible.

### Planned work
- **Per-format chunked adapters**: HDF5, Zarr, and Parquet nodes should support metadata-first browsing — shape, dtype, and a small preview are returned without loading the full payload. The `tree-index.json` node descriptor (ARCHITECTURE.md §7.3) already has `shape`, `dtype`, `size_bytes`, and `preview` fields for this purpose.
- **Paged/sliced read APIs**: Add `pdv.tree.get` payload options for `slice`, `page`, `max_bytes` so the renderer can request a partial view of a large node without materializing it.
- **Cache policy**: Define a maximum resident-data budget for the working directory. Nodes that exceed it are kept lazy until explicitly accessed. Eviction policy TBD.
- **UI inspectors**: Table inspector with paging and column statistics for DataFrames; array inspector with axis selection and histogram for ndarrays.

---

## 2) Modules System

### Goal
Modules are domain-specific analysis pipeline packages that can be installed into PDV, expose named actions, and be invoked from the UI. They are central to the community workflow vision: a researcher publishes a module for their diagnostic, others install it and run it on their own data without needing to understand the implementation.

### Planned work
- **Module manifest schema**: `pdv-module.json` with name, version, description, actions (name + script entrypoint), dependencies, and compatibility metadata.
- **Module discovery and installation**: Local directory scan and a future remote registry. Single-step install via the UI.
- **Action binding**: Module actions appear as buttons or context menu entries in the UI. Triggering an action calls `pdv_tree.run_script(path, **kwargs)` on the kernel (standard `execute_request` path — no special comm messages needed).
- **Per-module settings**: Module manifest can declare user-configurable parameters that are persisted in `project.json`.
- **Module health checks**: Version compatibility check at project load time; warning if a module action references a script that no longer exists.
- **Modules tab**: Currently a placeholder stub. Becomes the primary UI for browsing, installing, and configuring modules.

---

## 3) Full Julia Support

### Goal
The PDV comm protocol is designed to be language-agnostic (ARCHITECTURE.md §3). Julia support is explicitly deferred to beta (ARCHITECTURE.md §15). When implemented, Julia should have full parity with Python for all core workflows.

### Planned work
- **Kernel startup**: Add Julia kernel launch path to `KernelManager`. Connection file creation and ZeroMQ socket management are identical to Python.
- **`pdv-julia` package**: Julia equivalent of `pdv-python` — implements `bootstrap()`, `PDVTree`, the `pdv.kernel` comm target, and all message handlers. Serialization formats overlap with Python (`.npy`, `.parquet` are cross-language).
- **Project-level language selection**: `project.json` `language_mode` field (already in schema) drives kernel choice at open time.
- **Script parity**: `PDVScript` nodes in Julia projects use `.jl` files. Script editor, create/reload actions, and `run_script()` all need language-aware dispatch.
- **Julia integration tests**: Parity test suite comparable to the Python pytest suite.
- **Kernel-backed autocompletion** (see item 5): The `complete_request` Jupyter protocol message is language-agnostic; the Julia completion provider is registered using the same IPC channel as Python.

---

## 4) Remote Execution and Remote Data Access

### Goal
Remote compute and data access are essential for institutional and HPC workflows where data lives on cluster filesystems and computation must run on those machines rather than the user's laptop.

### Priority ordering
Per existing decisions: implement **remote data connectors** before remote kernel execution. First connector target is SSH/SFTP.

### Planned work

#### Remote data connectors (nearer term)
- **SSH/SFTP connector**: Mount a remote filesystem path as a read-only data source. Tree nodes can reference remote files; the connector fetches them on demand into the working directory.
- **Connector plugin interface**: Define an abstract `DataConnector` interface so additional backends (S3, POSIX NFS, Globus) can be added without changing core code.
- **Auth/credential management**: Secure storage for SSH keys and credentials. Session-level credential caching.

#### Remote kernel execution (later)
- **Transport abstraction**: Refactor `KernelManager` to support a `LocalTransport | SSHTransport | GatewayTransport` interface. Current local subprocess launch becomes `LocalTransport`.
- **Working directory rethink**: The current architecture passes a local working directory path to the kernel via `pdv.init` (ARCHITECTURE.md §4.1). For a remote kernel, the working directory must live on the remote host and be managed there. This is the primary architectural constraint to resolve — the `working_dir` concept will need to split into a local client directory and a remote kernel directory, with an SFTP sync layer between them.
- **SSH-tunneled kernel**: Spawn ipykernel on a remote host over SSH, tunnel ZeroMQ ports. Connection file is written on the remote host.
- **Jupyter Gateway support**: Connect to a pre-existing Jupyter kernel gateway (for institutional deployments).
- **Reconnect and recovery**: Detect dropped connections and offer to reconnect to a running remote kernel without losing session state.
- **Request-level authentication**: The PDV comm message envelope (ARCHITECTURE.md §3.2) currently has no auth fields. Remote deployments may require token or session-level signing on top of the Jupyter HMAC layer.

---

## 5) Kernel-Backed Autocompletion in the Code Cell

### Goal
Provide runtime-aware autocompletion in the Monaco editor code cell. Static language servers (Pylance, Pyright) are explicitly ruled out: they cannot see `pdv_tree` key paths, live namespace variables, or method chains on objects loaded in the current session. The running ipykernel uses jedi internally and introspects the live namespace — it produces exactly the completions that matter in a PDV workflow.

### Planned work

#### `KernelManager`: `complete_request` / `complete_reply`
The Jupyter Messaging Protocol defines `complete_request` on the shell socket, which `KernelManager` already owns. Add:
```ts
complete(kernelId: string, code: string, cursorPos: number): Promise<CompleteResult>
// CompleteResult: { matches: string[], cursorStart: number, cursorEnd: number }
```

#### IPC: `kernel:complete` channel
Add a `kernel:complete` handler in `ipc.ts` (already listed in `window.pdv.kernels.*` surface, ARCHITECTURE.md §11.2) that proxies to `KernelManager.complete()`.

#### `CodeCell`: Monaco completion provider
Register a completion item provider for Python after the editor mounts:
```ts
monaco.languages.registerCompletionItemProvider('python', {
  triggerCharacters: ['.', '[', "'", '"'],
  async provideCompletionItems(model, position) {
    const code = model.getValue();
    const offset = model.getOffsetAt(position);
    const result = await window.pdv.kernels.complete(kernelId, code, offset);
    // convert result.matches → CompletionItem[]
  }
});
```
Round-trip latency to a local kernel subprocess is typically a few milliseconds — well within Monaco's default provider timeout.

#### Implementation constraints
- The provider must be registered once globally (outside the component render cycle), not on every mount, to avoid duplicate provider registration across tab switches.
- If no kernel is running, `provideCompletionItems` returns `{ suggestions: [] }` rather than throwing.
- Monaco's `quickSuggestions`, `suggestOnTriggerCharacters`, and `wordBasedSuggestions` remain disabled (current `CodeCell` config). The registered provider above replaces them entirely with kernel-backed suggestions.
- When Julia support is added (item 3), register a separate provider for `julia` using the same IPC channel — `complete_request` is language-agnostic.

---

## 6) Rich Document Artifacts in the Tree

### Goal
Analysis is not only code and data. Researchers need to attach interpretation, notes, figures, and report fragments to the same project — and ideally write manuscript drafts directly alongside the data that informs them. Saved plots, Markdown notes, and PDF documents should be first-class tree node types, giving a project a unified record of data, code, and narrative.

### Planned work

#### Figure nodes (saved plots)
- **`figure` node type**: A first-class node type backed by a static image file (`.png`, `.svg`) or an interactive HTML bundle (`.html`, for Plotly/Bokeh output). Displayed inline in the tree panel's detail pane when selected.
- **`pdv.save_figure(path, fig=None)`** convenience on the `pdv` app object: saves the current matplotlib figure (or a passed figure object) to the tree at the given path. Example: `pdv.save_figure('results.fit_plot')`. Under the hood, calls `plt.savefig()` and registers the output file as a `figure` node via a `pdv.tree.changed` push notification — no explicit user step required.
- **Interactive figure support**: `display_data` output from Plotly and Bokeh produces an HTML bundle that can be captured as a `figure` node via a `pdv.save_figure()` variant accepting HTML strings.
- **Figure nodes are lazy-loaded** like any other file-backed node: the image or HTML is not read into memory until the user selects the node.

#### Markdown nodes (notes and manuscript fragments)
- **`text/markdown` node type**: Backed by a `.md` file in the working or save directory.
- **Split editor/renderer panel**: Selecting a Markdown node opens a two-pane view — Monaco editor on the left, live-rendered Markdown on the right. The renderer supports LaTeX math (via KaTeX), code blocks with syntax highlighting, and image references to other tree nodes by path.
- **`pdv.new_note(path, title=None)`** convenience: creates a Markdown node at the given path and opens it for editing in the split panel.
- **Manuscript workflow**: A researcher can write a section of a paper directly in PDV, reference saved figures by tree path, and keep the writing alongside the data and code that produced it. The `.md` file is plain text in the project directory and is also editable in any external editor; changes are detected and hot-reloaded via the watcher mechanism (see item 7).

#### PDF nodes
- **`application/pdf` node type**: Backed by a `.pdf` file. Renderer opens the PDF in a viewer panel (Electron renders PDFs natively via a `<webview>` or PDF.js embed).
- **Import action**: User can drag a PDF into the tree panel or use a context menu action to import an existing PDF as a node. The file is copied into the project save directory.
- **Document indexing**: Node descriptor `preview` field populated with the PDF title metadata or first-line text.

#### Cross-cutting
- All document node types (figure, markdown, PDF) appear in the tree with type-specific icons and preview text.
- `pdv.tree.list` responses include the `preview` field so the tree panel can show a useful label without loading the full content.

---

## 7) Tree Watchers and External Editor Hot Reload

### Goal
Script nodes are designed to be edited in external editors (ARCHITECTURE.md §11.2, `script:edit` IPC handler). When a script file changes on disk, PDV should detect it and prompt the user to reload.

### Planned work
- **File watch → push notification**: The main process watches script files in the working and save directories. On change, sends a push notification to the renderer via `BrowserWindow.webContents.send()`.
- **Stale indicator**: Tree panel shows a visual indicator on script nodes whose backing file has changed since last load.
- **Reload action**: User can trigger `pdv.script.register` comm with a reload flag from the context menu, or accept an auto-prompt.
- **Conflict handling**: If the script was also modified in the kernel session (e.g., `run_script()` wrote output), present a diff or reload choice.

---

## 8) Session Restore and Execution History

### Goal
Code cell tabs are already saved and restored as part of project save/load (ARCHITECTURE.md §8, `code-cells.json`). A future enhancement is optional capture of execution history so a session can be partially replayed or audited.

### Planned work
- **Execution timeline serialization**: Optionally record each execution event (code snapshot, timestamp, stdout/stderr/error summary) to a `execution-history.json` in the project directory.
- **Session restore**: On project load, offer to re-execute the last N commands in sequence ("replay session").
- **Configurable**: Off by default. Enabled per-project in project settings.

Note: Console output itself remains ephemeral by design (ARCHITECTURE.md §9.4). The execution history is a separate record — it captures inputs, not outputs.

---

## 9) Security, Trust, and Operational Guardrails

### Goal
As modules, remote execution, and community-shared projects arrive, the risk surface expands. A trust model is needed before these features go to production.

### Planned work
- **Project trust levels**: A project loaded from an unknown or community source is "untrusted" by default. Untrusted projects cannot execute scripts automatically; user must explicitly approve.
- **`trusted=True` gate**: The `unknown` node type (pickle-backed, ARCHITECTURE.md §7.2) is already gated on `trusted=True` in `serialization.py`. This flag should be surfaced in the UI and tied to the project trust level.
- **Signed modules**: Optional code-signing for module manifests. Allowlist policy for institutional deployments.
- **Execution audit trail**: Optionally record who ran what and when (user identity, script path, timestamp) for reproducibility in shared research environments. Complements item 8.

---

## 10) E2E Testing and Regression Infrastructure

### Goal
The alpha testing strategy (ARCHITECTURE.md §14) covers unit tests for Python and TypeScript in isolation. As the system matures, end-to-end tests across a real kernel process are needed.

### Planned work
- **E2E smoke tests**: Automated tests that spawn a real kernel, run the full startup sequence, execute code, modify the tree, save a project, and reload it. Confirms the full comm protocol path works end to end.
- **Fixture projects**: A set of representative saved projects (with varied node types and sizes) used as regression fixtures for load/save compatibility.
- **Project schema migration tests**: When `project.json` schema versions increment, automated tests confirm that older project files are correctly migrated.
- **Julia integration tests**: Parallel test suite to the Python pytest suite, run against a real Julia kernel.
- **CI tagging**: Slow tests (those that spawn real kernel processes) are tagged `@slow` and run in nightly CI, not on every commit.

---

---

# Beta Features (Target: 1.0.0)

The following features are lower priority than the Alpha Features above. Begin them only once the Alpha Features are stable and 0.1.0-beta1 has shipped. R kernel support is here because its prerequisite (Julia, item 3) is itself a later alpha item, making R genuinely long-horizon. Most other beta items are usability improvements that become important at community scale.

---

## B1) R Kernel Support

### Goal
R is widely used in experimental physics and statistics communities. The PDV comm protocol is language-agnostic (ARCHITECTURE.md §3). R has lower priority than Julia — implement Julia first and then reuse the same infrastructure.

### Planned work
- **IRkernel**: R support in Jupyter uses [IRkernel](https://irkernel.github.io/). `KernelManager` kernel launch and ZeroMQ socket management are identical to Python and Julia — no transport changes needed.
- **`pdv-r` package**: Implemented as an R package. Registers the `pdv.kernel` comm target with IRkernel, implements `PDVTree` as an R environment subclass, and handles all PDV message types. Serialization: Parquet via the `arrow` package; `.npy` exchange with Python requires a bridge (`reticulate` or a standalone reader).
- **Project-level language selection**: `project.json` `language_mode` gains `"r"` as a valid value (schema already supports free strings, ARCHITECTURE.md §6.2).
- **Script nodes**: `PDVScript` nodes in R projects use `.R` files. The `language` field in the node descriptor (ARCHITECTURE.md §7.3) is already a free string.
- **Autocompletion**: `complete_request` is language-agnostic; register an R completion provider using the same IPC channel as Python and Julia (see item 5).
- **R integration tests**: Parity test suite run against a real IRkernel process.

### Notes
- Do not begin until Julia support is complete and validated.
- Cross-language data exchange (opening a Python project in an R session) requires that shared formats (Parquet, JSON scalars) are handled correctly by both serializers. `.npy` files are not natively readable in R without a bridge.

---

## B2) Visualization Panel

### Goal
Matplotlib figures currently appear as static images in the Console via `display_data` output — ephemeral and disconnected from the data that produced them. A dedicated visualization surface would be a major usability improvement for scientific users.

### Planned work
- **Plot panel**: A persistent dockable panel that displays the most recently emitted figure, separate from the text console. Keeps the console clean for text output.
- **Interactive plot rendering**: Plotly and Bokeh output is HTML/JS; the plot panel renders it in a sandboxed `<webview>`, making interactive hover, zoom, and selection actually usable.
- **Integration with figure nodes** (see item 6): `pdv.save_figure()` saves the current plot to the tree; the plot panel shows a live preview of the unsaved current figure. These are complementary — the panel is transient, the tree node is persistent.

---

## B3) Tree Search and Filtering

### Goal
When a project grows to hundreds of nodes — realistic for any serious experiment — the tree panel becomes difficult to navigate without search. A filter bar is table-stakes for usability at scale.

### Planned work
- **Filter bar**: A text input above the tree panel that filters visible nodes by name substring in real time. Matching nodes and their ancestors remain visible; non-matching nodes are hidden.
- **Type filter**: Toggle buttons or a dropdown to show only nodes of a given type (e.g., `script`, `ndarray`, `figure`).
- **Search**: A deeper search (Cmd+F or command palette entry) that queries node names, preview text, and Markdown content across the full tree, not just the currently expanded subtree.

---

## B4) Data Ingest Wizard

### Goal
There is currently no way to get data into the tree without writing code. For scientists with existing files (CSV, HDF5, MATLAB `.mat`, netCDF), a UI-driven import flow lowers the barrier significantly — especially for experimentalists who are not primarily programmers.

### Planned work
- **Import dialog**: Browse to a file, PDV detects format and shows a preview (column names, shape, dtype), user assigns a tree path and clicks Import.
- **Supported formats at launch**: CSV (→ DataFrame), HDF5 (→ folder of arrays), NumPy `.npy`/`.npz`, MATLAB `.mat` (via `scipy.io`), netCDF (via `netCDF4` or `xarray`), plain text.
- **Batch import**: Select a directory; PDV proposes a tree structure mirroring the directory layout, user confirms or edits before importing.
- **IPC path**: Import is executed by the kernel (not the main process) so that format detection and loading use the full Python scientific stack.

---

## B5) Physical Units and Quantity Metadata

### Goal
NumPy arrays in physics contexts almost always represent quantities with units (Tesla, milliseconds, keV). If that information is stripped when data enters the tree, users must remember and document it themselves through variable names or comments — a common source of errors.

### Planned work
- **`pint.Quantity` node type**: Recognize `pint.Quantity` objects in `serialization.py`'s `detect_kind()` and serialize them with their unit string preserved alongside the numeric payload.
- **`units` metadata field on node descriptors**: A lightweight alternative that does not require `pint` — any node can carry an optional `units: string` in its `tree-index.json` descriptor. Available to all node types, not just arrays.
- **UI display**: The tree panel shows the `units` field in the node preview (e.g., `float64 array (1024,) [T]`). Node detail pane shows full unit string.
- **User-editable units**: The node detail pane allows the user to set or correct the `units` field on any node without re-running code.

---

## B6) Per-Node Annotations

### Goal
Scientists frequently need to annotate individual data nodes: "this was the bad shot," "calibration from 2025-01-15," "rerun with corrected geometry." Currently the only way to attach a note to a node is to create a sibling Markdown node manually.

### Planned work
- **`annotation` field on node descriptors**: A free-text string stored in `tree-index.json` alongside the other node metadata. Writable by the user from the tree panel detail pane.
- **UI**: The tree panel shows an annotation indicator icon on nodes that have one. Hovering shows the full text as a tooltip. Clicking opens an inline edit field.
- **Persistence**: Written to `tree-index.json` at save time, restored at load time. No kernel round-trip needed — the main process owns this field.

---

## B7) Reproducible Environment Lockfiles

### Goal
The architecture detects and installs Python environments but does not record which package versions were active during a session. For reproducible science, a project should be able to declare its computational environment so that results can be reproduced later or by a collaborator.

### Planned work
- **Session environment snapshot**: At save time, run `pip freeze` (or `conda env export`) in the active environment and write the output to `requirements-session.txt` (or `environment-session.yml`) in the project save directory.
- **`project.json` extension**: Add a `environment_snapshot` field pointing to the snapshot file and recording Python version, platform, and PDV version.
- **UI display**: The project info panel (or Settings dialog) shows the environment that was active when the project was last saved, with a warning if the current environment differs significantly.
- **Off by default**, on by default for new projects (configurable).

---

## B8) Command Palette

### Goal
A `Cmd+Shift+P`-style command palette for discoverability. Scientists exploring a new tool will not read documentation — they will press the keyboard shortcut they know from VS Code and expect to find things. A command palette surfaces all tree actions, script operations, project commands, and settings behind a single searchable interface.

### Planned work
- **Global keybinding**: `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows/Linux) opens the palette from anywhere in the UI.
- **Command registry**: A central registry of all available commands with labels, descriptions, and keyboard shortcuts. Module actions (item 2) and script actions register entries here automatically.
- **Fuzzy search**: Type to filter commands by keyword. Recent commands shown at the top.
- **Context sensitivity**: Commands that are not applicable in the current state (e.g., script actions when no script is selected) are greyed out rather than hidden, so users can discover them without confusion.

---

## B9) GitHub Copilot Integration

### Goal
Surface GitHub Copilot completions and chat inside the PDV code editor. PDV's Monaco-based code cells should feel like a first-class Copilot-enabled editor for physicists: inline ghost-text completions as you type, and a Copilot Chat panel for asking questions about data, scripts, and analysis.

### Background
GitHub Copilot is exposed to third-party editors through two mechanisms:
- **Language Server Protocol (LSP)**: [copilot-language-server](https://github.com/github/copilot-language-server) is a standalone Node.js binary (distributed via npm) that speaks a Copilot-extended LSP protocol. Editors register with it to receive inline completions.
- **GitHub Copilot Chat**: Requires the Copilot Chat API, currently gated behind GitHub's partner programme.

### Planned work

#### Authentication
- The `copilot-language-server` handles GitHub OAuth itself (browser redirect to `github.com/login/device`). PDV's main process spawns the language server and opens the device-activation URL in the system browser.
- Token storage: the language server manages its own token cache (`~/.config/github-copilot/`). PDV does not store credentials.

#### Language server lifecycle
- `copilot-ls.ts` (new main-process module): spawns `copilot-language-server --stdio` as a child process using the npm-installed binary; implements the LSP `initialize` / `initialized` handshake; forwards `textDocument/didOpen`, `textDocument/didChange`, and `getCompletions` over `stdin`/`stdout`.
- Gracefully degrades: if the binary is not installed, Copilot features are silently absent (no hard dependency).

#### Monaco inline completions
- Register a Monaco `InlineCompletionsProvider` for `python` (and `julia` when Julia support lands).
- On each completion trigger, send `getCompletions` to the language server via the `copilot:complete` IPC channel and return the results as `InlineCompletion` items.
- Ghost text rendering uses Monaco's built-in inline completion UI — no custom rendering required.

#### IPC surface
- `copilot:status` — returns `'not-installed' | 'signed-out' | 'signed-in'`.
- `copilot:signin` — triggers the device-flow OAuth sequence; returns the activation URL to display.
- `copilot:complete` — forwards a completion request to the language server; returns `{ completions: string[] }`.

#### Settings integration
- Add a **Copilot** section to the General settings tab: enable/disable toggle, sign-in/sign-out button, status indicator.
- Respect the `quickSuggestions: false` Monaco option — Copilot inline completions are a separate provider and are unaffected by that option.

#### Copilot Chat (later)
- Copilot Chat requires access to the GitHub Copilot Chat API. Gate this behind a separate feature flag until API access is confirmed.
- If available: a collapsible chat panel alongside the namespace/tree panes, pre-seeded with the active cell's code and the current tree structure as context.

### Notes
- Inline completions do not require Copilot Business/Enterprise; a standard Copilot Individual subscription is sufficient.
- The language server binary must be installed separately (`npm install -g @github/copilot-language-server` or bundled). Document both paths.
- Do not block on this feature — item 5 (kernel-backed autocompletion) is the higher-priority completion path and should ship first.

---

## B10) Module Manifest Editor

### Goal
Creating `pdv-module.json` files by hand is error-prone for users who primarily work in Python. PDV should provide a guided authoring flow so module manifests can be created and maintained without manual JSON editing.

### Planned work
- **GUI-first editor**: Add a manifest editor to the Modules tab with structured fields for name, version, description, actions, dependencies, and compatibility metadata.
- **Schema-aware validation**: Validate required fields and value types inline before save, with clear error messages.
- **Action editor UX**: Provide an action list/table editor for action name, script entrypoint, and parameter metadata.
- **Round-trip editing**: Open existing `pdv-module.json`, edit in the UI, and save updated manifests from the same workflow.
- **Preview and export**: Show the generated JSON before writing, and export canonical `pdv-module.json`.
- **Alternative authoring path (later)**: Keep room for a TOML/YAML import or converter script, but treat this as secondary to the GUI path.

---

## 12) Known Design Tensions to Resolve

These are architectural decisions in the current design that are correct for 0.0.2-alpha2 but will create friction as the system grows. They should be resolved before or during the Alpha Feature implementation phase.

### Dot-delimited tree paths and key collision
`PDVTree` supports dot-separated path notation (`pdv_tree['data.waveforms.ch1']`). Keys that themselves contain dots are ambiguous — `pdv_tree['my.key']` is indistinguishable from `pdv_tree['my']['key']`. This is acceptable for alpha (physics variable names rarely contain dots) but needs a resolution before community use. Options: escape sequences, a separate `pdv_tree.at('my.key')` method for literal keys, or abandoning dot notation in favour of `pdv_tree['my']['key']` exclusively.

### Working directory is local-only
By design, the working directory is a local temp path passed to the kernel via `pdv.init` (ARCHITECTURE.md §4.1, §6.1). This is correct for local execution but is the primary constraint for remote kernel support (see item 4). When remote execution is designed, this contract must be explicitly renegotiated.

### Autosave is reserved but unimplemented
The working directory structure includes a `.pdv-work/autosave/` path (ARCHITECTURE.md §6.1). The autosave feature is not designed yet. This directory should not be used for other purposes.

### Console history is ephemeral
Console output is intentionally not persisted (ARCHITECTURE.md §9.4). If the optional execution history feature (item 8) is implemented, it must remain a separate system — the console display path must not be modified to add persistence.

---

## 13) Suggested Implementation Sequence

### Alpha Features → 0.1.0-beta1

1. Modules system — manifest + install + action binding (item 2)
2. Kernel-backed autocompletion (item 5) — high value, low scope, fits cleanly into existing IPC
3. Rich document artifacts — figures, Markdown editor, PDF (item 6)
4. Advanced lazy loading — chunked reads for HDF5/Zarr/Parquet (item 1)
5. Tree watchers and hot reload (item 7)
6. SSH/SFTP remote data connector (item 4, connector phase only)
7. Julia parity + tests (item 3)
8. Remote kernel execution — transport abstraction + SSH tunnel (item 4, execution phase)
9. Security and trust model (item 9) — required before community module distribution
10. Session restore and execution history (item 8)
11. E2E test infrastructure expansion (item 10)

### Beta Features → 1.0.0

Begin only after 0.1.0-beta1 is stable. Suggested order:

1. B3 — Tree search and filtering (cheap, high daily-use impact)
2. B8 — Command palette (discoverability, especially for new users)
3. B10 — Module manifest editor (reduce friction for module authoring)
4. B2 — Visualization panel
5. B4 — Data ingest wizard
6. B5 — Physical units and quantity metadata
7. B6 — Per-node annotations
8. B7 — Reproducible environment lockfiles
9. B9 — GitHub Copilot integration (inline completions; Chat if API access granted)
10. B1 — R kernel support (last; requires Julia to be complete first)

---

## 14) Release Completion Criteria

### 0.1.0-beta1 — Alpha Feature Complete

PDV is ready to ship 0.1.0-beta1 when all of the following are true:

- Projects open and save reliably with complete state; older project files load without data loss
- Tree is persistent, scalable, and lazily browsable for large datasets (100GB+)
- Code cell state is project-managed and recoverable
- Kernel-backed autocompletion works in the code cell for Python (and Julia when supported)
- Modules are installable and runnable via manifest-driven UI actions
- Rich document artifacts (figures, Markdown notes, PDFs) are first-class tree nodes
- Python and Julia have practical parity for all core workflows
- Remote data access (SSH/SFTP) is production-usable
- Remote kernel execution is production-usable
- A trust model governs untrusted projects and unsigned modules
- E2E test coverage spans kernel startup, execution, tree save/load, and script execution

### 1.0.0 — Beta Feature Complete

PDV is ready to ship 1.0.0 when all of the following are additionally true:

- Tree search and filtering work reliably across projects with hundreds of nodes
- A command palette surfaces all actions and is the primary discoverability mechanism
- A visualization panel provides a persistent, interactive plot surface
- A data ingest wizard supports importing CSV, HDF5, MATLAB, netCDF, and NumPy files without writing code
- Module manifests can be authored and edited from a GUI flow without hand-writing JSON
- Physical units are preserved through the tree for arrays and scalars where provided
- Per-node annotations are supported and persisted in the project
- Session environment is snapshotted at save time for reproducibility
- R kernel support is production-quality with parity to Python for core workflows
