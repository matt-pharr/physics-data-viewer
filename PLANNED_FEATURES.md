# PDV Planned Features

This document describes features that are planned for PDV beyond the core alpha implementation. The alpha architecture (specified in [`ARCHITECTURE.md`](ARCHITECTURE.md)) establishes the process model, PDV comm protocol, tree authority model, project save/load format, and IPC surface. Everything in this document is additive to that foundation.

For the implementation sequence of the alpha itself, see [`IMPLEMENTATION_STEPS.md`](IMPLEMENTATION_STEPS.md).

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

## 5) Kernel-Backed Autocompletion in the Command Box

### Goal
Provide runtime-aware autocompletion in the Monaco editor command box. Static language servers (Pylance, Pyright) are explicitly ruled out: they cannot see `pdv_tree` key paths, live namespace variables, or method chains on objects loaded in the current session. The running ipykernel uses jedi internally and introspects the live namespace — it produces exactly the completions that matter in a PDV workflow.

### Planned work

#### `KernelManager`: `complete_request` / `complete_reply`
The Jupyter Messaging Protocol defines `complete_request` on the shell socket, which `KernelManager` already owns. Add:
```ts
complete(kernelId: string, code: string, cursorPos: number): Promise<CompleteResult>
// CompleteResult: { matches: string[], cursorStart: number, cursorEnd: number }
```

#### IPC: `kernel:complete` channel
Add a `kernel:complete` handler in `ipc.ts` (already listed in `window.pdv.kernels.*` surface, ARCHITECTURE.md §11.2) that proxies to `KernelManager.complete()`.

#### `CommandBox`: Monaco completion provider
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
- Monaco's `quickSuggestions`, `suggestOnTriggerCharacters`, and `wordBasedSuggestions` remain disabled (current `CommandBox` config). The registered provider above replaces them entirely with kernel-backed suggestions.
- When Julia support is added (item 3), register a separate provider for `julia` using the same IPC channel — `complete_request` is language-agnostic.

---

## 6) Rich Document Artifacts in the Tree

### Goal
Analysis is not only code and data. Teams need to attach interpretation, notes, and reports to the same project. Markdown notes and PDF reports should be first-class tree node types.

### Planned work
- **Markdown nodes**: `text/markdown` node type. Renderer shows a preview panel with rendered Markdown. Editing opens an inline split editor/preview.
- **PDF nodes**: `application/pdf` node type. Renderer opens the PDF in a viewer panel (Electron can render PDFs natively via `<webview>` or a PDF.js embed).
- **Document indexing**: Node descriptor `preview` field populated with the document title or first-line heading.
- **Research note workflow**: A `pdv.new_note()` convenience exposed via the `pdv` app object that creates a Markdown node at a given tree path and opens it for editing.

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
Command box tabs are already saved and restored as part of project save/load (ARCHITECTURE.md §8, `command-boxes.json`). A future enhancement is optional capture of execution history so a session can be partially replayed or audited.

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

## 11) R Kernel Support

### Goal
R is widely used in experimental physics communities for statistical analysis and data visualization. The PDV comm protocol is language-agnostic (ARCHITECTURE.md §3), and the architecture already lists R support under explicit future deferral alongside Julia (ARCHITECTURE.md §15). R has lower priority than Julia — add Julia first, then use the same infrastructure for R.

### Planned work
- **IRkernel**: R support in Jupyter uses [IRkernel](https://irkernel.github.io/). `KernelManager` kernel launch and ZeroMQ socket management are identical to Python and Julia — no transport changes needed.
- **`pdv-r` package**: R equivalent of `pdv-python`, implemented as an R package. Registers the `pdv.kernel` comm target with IRkernel, implements `PDVTree` as an R environment subclass, and handles all PDV message types. Serialization: Parquet is well-supported via the `arrow` R package; `.npy` for ndarray exchange with Python requires a bridge (the `reticulate` package or a standalone npy reader).
- **Project-level language selection**: `project.json` `language_mode` (already in schema, ARCHITECTURE.md §6.2) gains `"r"` as a valid value.
- **Script nodes**: `PDVScript` nodes in R projects use `.R` files. The `language` field in the node descriptor (ARCHITECTURE.md §7.3) is already a free string for this purpose.
- **Autocompletion**: `complete_request` is language-agnostic; register an R completion provider in `CommandBox` using the same IPC channel as Python and Julia (see item 5).
- **R integration tests**: Parity test suite comparable to the Python pytest suite, run against a real IRkernel process.

### Notes
- R is the lowest-priority language target. Do not begin until Julia support is complete and validated.
- Cross-language data exchange between R and Python projects (e.g., opening a Python-saved project in an R session) requires that shared formats (Parquet, JSON scalars) are handled correctly by both the `pdv-python` and `pdv-r` serializers. `.npy` files written by Python sessions are not natively readable in R without a bridge.

---

## 12) Known Design Tensions to Resolve

These are architectural decisions in the current design that are correct in scope for alpha but will create friction as the system grows.

### Dot-delimited tree paths and key collision
`PDVTree` supports dot-separated path notation (`pdv_tree['data.waveforms.ch1']`). Keys that themselves contain dots are ambiguous — `pdv_tree['my.key']` is indistinguishable from `pdv_tree['my']['key']`. This is acceptable for alpha (physics variable names rarely contain dots) but needs a resolution before community use. Options: escape sequences, a separate `pdv_tree.at('my.key')` method for literal keys, or abandoning dot notation in favour of `pdv_tree['my']['key']` exclusively.

### Working directory is local-only
By design, the working directory is a local temp path passed to the kernel via `pdv.init` (ARCHITECTURE.md §4.1, §6.1). This is correct for local execution but is the primary constraint for remote kernel support (see item 4). When remote execution is designed, this contract must be explicitly renegotiated.

### Autosave is reserved but unimplemented
The working directory structure includes a `.pdv-work/autosave/` path (ARCHITECTURE.md §6.1). The autosave feature is not designed yet. This directory should not be used for other purposes.

### Console history is ephemeral
Console output is intentionally not persisted (ARCHITECTURE.md §9.4). If the optional execution history feature (item 8) is implemented, it must remain a separate system — the console display path must not be modified to add persistence.

---

## 13) Suggested Implementation Sequence (Post-Alpha)

Recommended priority order for features above:

1. Modules system — manifest + install + action binding (item 2)
2. Kernel-backed autocompletion (item 5) — high value, low scope, fits cleanly into existing IPC
3. Advanced lazy loading — chunked reads for HDF5/Zarr/Parquet (item 1)
4. Tree watchers and hot reload (item 7)
5. SSH/SFTP remote data connector (item 4, connector phase only)
6. Julia parity + tests (item 3)
7. Rich document artifacts — Markdown and PDF (item 6)
8. Remote kernel execution — transport abstraction + SSH tunnel (item 4, execution phase)
9. Security and trust model (item 9) — required before community module distribution
10. Session restore and execution history (item 8)
11. E2E test infrastructure expansion (item 10)
12. R kernel support (item 11) — lowest priority; begin only after Julia is complete

---

## 14) Definition of "Feature Complete" (relative to current vision)

PDV can be considered close to the described target when all of the following are true:

- Projects open and save reliably with complete state; older project files load without data loss
- Tree is persistent, scalable, and lazily browsable for large datasets (100GB+)
- Command box state is project-managed and recoverable
- Kernel-backed autocompletion works in the command box for Python (and Julia when supported)
- Modules are installable and runnable via manifest-driven UI actions
- Python and Julia have practical parity for all core workflows
- Remote data access (SSH/SFTP) is production-usable
- Remote kernel execution is production-usable
- Markdown and PDF artifacts integrate naturally into the tree workflow
- A trust model governs untrusted projects and unsigned modules
- Python and Julia have practical parity for all core workflows; R support is a bonus, not a requirement
