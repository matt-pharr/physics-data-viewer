# LSP Integration Design — Physics Data Viewer

## Overview

This document describes the design for integrating Language Server Protocol (LSP) support
into PDV. The goal is a generic, extensible architecture that allows any language — current
(Python, Julia) or future — to supply rich editor intelligence in the Monaco editor, without
hardcoding assumptions about any particular language server. Users and Modules can register
their own LSP configurations. The system handles auto-detection of already-running servers
and provides a guided setup flow in the Settings dialog when a server is missing.

---

## 1. Background and Constraints

### 1.1 Monaco and LSP

Monaco Editor does not natively consume Language Server Protocol. It has its own built-in
intelligence for JavaScript, TypeScript, CSS, and HTML, but for other languages it exposes
a lower-level API (`registerCompletionItemProvider`, `registerHoverProvider`, etc.) that
external code must implement.

The established bridge is the `monaco-languageclient` library, which implements the
LSP client side and translates between Monaco's API and the JSON-RPC messages that LSP
servers speak. On the transport side it uses a WebSocket (or `vscode-jsonrpc` wrapped
connection), meaning the LSP server must be reachable over a socket — either a TCP
port the server is already listening on, or one that PDV's main process opens as a
forwarding proxy.

### 1.2 Electron Architecture Fit

PDV already has a clear main-process / renderer boundary:

- **Main process** manages OS-level resources: kernel processes, filesystem, config. It is
  the right owner for spawning LSP server processes and holding their sockets.
- **Renderer** runs Monaco and owns the editor UX. It is the right place to run the
  `monaco-languageclient` instance and apply LSP results to the editor.
- **Preload bridge** (`window.pdv`) is the typed contract between the two.

LSP fits naturally into this model: main process owns LSP server lifecycles, renderer owns
LSP client lifecycles, and a small set of new IPC channels and a local WebSocket proxy
connect them.

---

## 2. Core Concepts

### 2.1 LSP Server Definition

An **LSP Server Definition** is a plain data record describing everything needed to locate,
start, and connect to a language server for one language:

```
LanguageId        — canonical string key, e.g. "python", "julia", "r"
displayName       — human-readable label shown in Settings
fileExtensions    — array of file extensions this server handles, e.g. [".py"]
transport         — "stdio" | "tcp" | "websocket"
command           — command to launch the server (optional if detect-only)
args              — default arguments for the server process
detectPorts       — list of TCP ports to probe for an already-running server
detectCommands    — list of executables to check for availability
documentationUrl  — link to setup instructions shown in Settings
```

A definition does **not** dictate policy — it only describes what is available and how to
reach it. PDV ships built-in definitions for Python and Julia. Modules and users can
contribute additional ones.

### 2.2 LSP Registry

The **LSP Registry** is the in-memory catalog of all known definitions. It is populated in
order of priority (later entries override earlier ones for the same `languageId`):

1. PDV built-in definitions (Python, Julia)
2. Definitions contributed by installed Modules (from each module's manifest)
3. User overrides stored in app config

This layered model means that a module adding support for, say, R will automatically appear
in Settings and in the editor without any changes to PDV's core code.

### 2.3 LSP Server Manager (Main Process)

The **LSP Server Manager** runs in the main process and is responsible for:

- Probing for already-running external servers (port scan, socket ping)
- Launching managed server processes (stdio or TCP)
- Maintaining a local WebSocket proxy that the renderer connects to
- Tracking per-language connection state: `not_configured | detecting | available |
  running | connected | error`
- Cleanly stopping managed processes on app quit or project close

### 2.4 LSP Client (Renderer)

The **LSP Client** runs in the renderer and is responsible for:

- Creating a `monaco-languageclient` instance per connected language
- Connecting to the main process's WebSocket proxy on the loopback interface
- Registering the client's capabilities against the Monaco editor instance
- Disposing the client when the editor tab closes or the language switches

### 2.5 LSP Proxy (Main Process WebSocket Server)

Because renderers in Electron are sandboxed, direct TCP sockets to arbitrary ports are not
accessible. The solution is a lightweight **loopback WebSocket server** run in the main
process. For each language server connection, the main process:

1. Listens on a randomly assigned loopback port (127.0.0.1 only, never LAN-exposed)
2. Bridges incoming WebSocket frames to the LSP server process via stdio or a direct TCP
   socket to the external server

The renderer's `monaco-languageclient` connects to this loopback port. Because the proxy
lives in the main process, it has access to both the renderer-facing WebSocket and the
OS-level process/socket of the language server.

---

## 3. IPC Contract Extension

The following new IPC channels would be added to `ipc.ts`:

```
lsp:list           → returns all registered definitions and their current state
lsp:detect         → probe a specific languageId; returns detected state
lsp:connect        → request connection to the LSP for a languageId
lsp:disconnect     → close the LSP connection for a languageId
lsp:status         → get current connection state for a languageId
lsp:configure      → update user config for a language server
lsp:port           → return the loopback proxy port for a connected language
```

A push notification channel would also be added:

```
lsp:state-change   → renderer push event when any language server changes state
```

The renderer subscribes to `lsp:state-change` to update status badges in the Settings
dialog and editor toolbar without polling.

### 3.1 New Config Fields

The existing `Config` interface would gain:

```typescript
languageServers?: {
  [languageId: string]: {
    enabled: boolean;
    command?: string;      // override default command
    args?: string[];       // override default args
    port?: number;         // manual port for external server
    autoStart: boolean;    // start server on app launch if not detected
  }
}
```

These are the user-editable fields. The built-in definition provides defaults; user config
only stores deltas from those defaults.

---

## 4. Detection Flow

When PDV starts (or when the user opens a project with a given language), the LSP Server
Manager runs the detection sequence for that language:

```
1. Check user config: is this languageId explicitly disabled? → skip
2. Check detectPorts from the definition:
     For each port: attempt TCP connect to 127.0.0.1:<port>
     If successful → mark as "available (external)" and record port
3. Check detectCommands from the definition:
     For each executable: run `which <cmd>` (or equivalent on Windows)
     If found → mark executable as available; note it can be launched
4. Emit lsp:state-change with the result

Result states after detection:
  "external_running"  — found an existing server on a known port
  "launchable"        — no running server found, but a known binary is on PATH
  "not_found"         — nothing detected; user must configure manually
  "disabled"          — user has explicitly disabled this language server
```

Detection is non-blocking and runs in the background. The editor starts before detection
completes — the Monaco editor works fine without LSP and gains capabilities incrementally
as the connection establishes.

---

## 5. Connection Lifecycle

### 5.1 Auto-connect

If detection finds `external_running`, the main process:
1. Creates a WebSocket proxy bound to a random loopback port
2. The proxy bridges to the detected external server port (or stdio if server was launched)
3. Emits `lsp:state-change` with state `connected` and the proxy port

If detection finds `launchable` and `autoStart` is true in config:
1. Spawns the language server process using the configured command
2. Creates the proxy
3. Emits `connected`

### 5.2 Manual connect

The user can trigger connection from the Settings → Language Servers tab:
- "Connect" button for external servers (prompts for port if not auto-detected)
- "Start" button to launch a managed server when `autoStart` is false

### 5.3 Renderer-side connection

Once the renderer receives `connected` with a proxy port, it:
1. Constructs a `WebSocket` connection to `ws://127.0.0.1:<port>`
2. Creates a `monaco-languageclient` `MonacoLanguageClient` instance
3. Associates the client with the Monaco editor model for files matching the language's
   `fileExtensions`
4. The client negotiates capabilities with the server (completions, hover, diagnostics,
   go-to-definition, etc.)

When the editor tab for a language is closed, the client is disposed. The server process
(if managed by PDV) remains running unless explicitly stopped, so reconnecting to a new
tab is instant.

### 5.4 Disconnect / Shutdown

On app quit:
- All managed server processes receive SIGTERM and a grace period before SIGKILL
- All proxy WebSocket servers close

On "Stop" in Settings:
- The managed server process is terminated
- The proxy closes
- The renderer's language client is notified and disposes
- State reverts to `launchable` (or `not_found` if the binary is no longer available)

---

## 6. Settings Dialog — Language Servers Tab

A new tab, **Language Servers**, would be added to the existing Settings dialog alongside
Shortcuts, Appearance, and Runtime. The tab renders one card per registered language
definition. Each card shows:

```
[Language Icon] Python
Status badge:  ● Connected  (green)
               ○ Available (not started)  (yellow)
               ○ Not found  (red)
               ○ Disabled  (grey)

Server:        pylsp  (auto-detected on port 2087)
               [Disconnect]  [Stop Server]

─── or ───

Server:        Not detected
               Command: [___________________]  [Browse]
               Port:    [      ]  (for external servers)
               [Start]  [Test Connection]

Auto-start:    [ ] Start automatically with PDV

Documentation: "How to install pylsp →"
```

The card is populated from the LSP definition's `detectCommands`, `detectPorts`, and
`documentationUrl`. The user-editable command/port fields write back into
`config.languageServers[languageId]`.

For languages added by Modules, their cards appear in the same tab automatically — there is
no separate "module language servers" section. The card shows which module contributed the
definition.

### 6.1 Status Indicator in Editor Toolbar

A small status indicator (e.g. `{}` icon with a coloured dot) would appear in the Command
Box toolbar. Clicking it opens the Language Servers tab in Settings directly. This gives
the user immediate visibility without opening Settings manually.

---

## 7. Python-Specific Behaviour

Python is the default language in PDV today. The built-in Python LSP definition would
target the most common community options in detection order:

1. **Pylsp** (Python Language Server, formerly `python-language-server`)
   - Common install: `pip install python-lsp-server`
   - Typical invocation: `pylsp` (stdio mode by default)
   - Detect: check `pylsp` on PATH; check port 2087 if user is known to run it via TCP

2. **Pyright**
   - Common install: `pip install pyright` or `npm install -g pyright`
   - Invocation: `pyright-langserver --stdio`
   - Detect: check `pyright-langserver` or `pyright` on PATH

3. **Jedi Language Server**
   - Common install: `pip install jedi-language-server`
   - Invocation: `jedi-language-server`

Detection uses the **Python executable already configured in PDV** (`config.pythonPath`),
not just the system PATH. This means:

```
<pythonPath> -m pylsp          # preferred: use the configured environment
pylsp                          # fallback: check system PATH
```

This is important for users with virtual environments. If the user changes `pythonPath` in
the Runtime tab, LSP detection runs again for Python automatically.

The first successfully detected option is used. The user can override this in the Language
Servers tab.

---

## 8. Julia-Specific Behaviour

The Julia language server ecosystem is more uniform:

- **LanguageServer.jl** is the canonical server
- Invocation: `julia --project=@. -e 'using LanguageServer; runserver()'` (simplified)
- Detection: check `juliaPath` from config, probe for `LanguageServer` in the Julia
  environment

Because Julia has a long startup time for the language server, PDV should:
1. Default `autoStart` for Julia LSP to `false` (opt-in, not opt-out)
2. Show a prominent "Start Julia Language Server" action in the Language Servers tab
3. Consider caching the Julia sysimage via `PackageCompiler.jl` — the Settings card could
   show a "Compile sysimage for faster startup" action if the user wants it

---

## 9. Module Integration

A Module manifest (`module.json`) can declare LSP support via a top-level `languageServers`
array:

```json
{
  "name": "MyModule",
  "languageServers": [
    {
      "languageId": "r",
      "displayName": "R Language Server",
      "fileExtensions": [".r", ".R", ".Rmd"],
      "transport": "stdio",
      "command": "R",
      "args": ["--slave", "-e", "languageserver::run()"],
      "detectCommands": ["R"],
      "documentationUrl": "https://github.com/REditorSupport/languageserver"
    }
  ]
}
```

When the module is enabled, the LSP Registry incorporates its definitions. When the module
is disabled or uninstalled, those definitions are removed and any active connections are
closed.

This contract keeps the core PDV code free of language-specific logic while allowing the
community to contribute arbitrary language support through the Module system.

---

## 10. Workspace and Document Synchronisation

LSP servers work at the level of the **workspace** and **open documents**. PDV's equivalent
concepts are:

| LSP Concept         | PDV Equivalent                                           |
|---------------------|----------------------------------------------------------|
| Workspace root      | Project tree root directory (`config.treeRoot`)          |
| Open document       | Active command box tab (or script open in command box)   |
| Document URI        | File path of script node, or a synthetic in-memory URI  |
| didOpen / didChange | Fired when code changes in Monaco, debounced             |
| didClose            | Fired when a command tab is removed                      |

For ephemeral command box content (code not backed by a file), a synthetic URI scheme
would be used, e.g. `pdv-memory://session/<tabId>.py`. LSP servers generally support this
for single-file intelligence even without a full project root.

For script nodes that have a backing file path (`_file_path` on `TreeNode`), the real file
URI should be used. This gives the language server full project context when the user is
editing a script from the tree.

---

## 11. Capability Scope

Not all LSP capabilities need to be enabled immediately. A phased approach:

**Phase 1 — Core intelligence (high value, low risk):**
- Completions (the biggest win; replaces the current basic `kernels:complete` for symbols)
- Hover documentation
- Signature help (function argument hints)
- Diagnostics (inline errors/warnings without executing code)

**Phase 2 — Navigation:**
- Go to definition
- Find references
- Rename symbol

**Phase 3 — Advanced (optional, can be disabled by default):**
- Code actions (quick fixes, imports)
- Formatting (on save or on command, using server's formatter)
- Inlay hints
- Semantic token highlighting

Each capability group is independently configurable per language in the Language Servers
settings card, so users can keep a minimal profile if they want lighter behaviour.

---

## 12. Interaction with Existing Kernel Completion

PDV already uses `kernels:complete` and `kernels:inspect` to provide completions and
inspection results via the running Jupyter kernel. This gives runtime-aware completions
(variables in scope, dynamic attributes). LSP gives static-analysis completions (type
stubs, project-wide symbols, library documentation).

The two systems are **complementary**, not redundant:

- **LSP completions** fire first (faster, no kernel round-trip, available even when kernel
  is busy)
- **Kernel completions** supplement with runtime context (variables, module contents
  known to the live kernel)

Monaco supports multiple completion providers for the same language, ranking them by
priority. The LSP provider should be registered at a slightly lower priority than the
kernel provider so that live runtime context wins when available. Users who want pure LSP
can disable the kernel completion provider in settings.

---

## 13. Security Considerations

Language servers run as OS processes with the user's permissions. Key boundaries to
maintain:

- **Loopback only**: The WebSocket proxy must only bind to `127.0.0.1`, never `0.0.0.0`
  or a LAN interface. No external machine should be able to reach an LSP server via PDV.

- **No auto-install**: PDV should never install a language server on behalf of the user.
  It detects and connects; the user installs. The Settings card provides the install
  command as a copyable snippet and a link to documentation.

- **Managed process sandboxing**: When PDV spawns an LSP server, it should pass only the
  project root as the workspace, not the entire filesystem. Servers should not receive
  environment variables that contain secrets (API keys, tokens) unless they are explicitly
  in the user's shell environment already.

- **Module-contributed definitions are not trusted to execute arbitrary code at LSP
  connect time.** The command fields in a module manifest are shown to the user in Settings
  before being used. The user must explicitly "Start" a module-contributed server.

---

## 14. Phased Rollout

### Phase A — Infrastructure (no user-visible LSP yet)

- Add `languageServers` to `Config` schema
- Add IPC channels (`lsp:list`, `lsp:detect`, `lsp:status`, `lsp:configure`)
- Implement `LSPRegistry` with built-in Python and Julia definitions
- Implement `LSPServerManager` with detection logic (no process spawning yet)
- Add Language Servers tab to Settings dialog showing detection results only

### Phase B — Python connection

- Implement the loopback WebSocket proxy in main process
- Implement `monaco-languageclient` wiring in renderer (CommandBox)
- Enable Phase 1 capabilities (completions, hover, diagnostics, signature help) for Python
- Add auto-connect for `external_running` state
- Add "Start" action for `launchable` state

### Phase C — Julia connection

- Add Julia LSP definition and detection
- Implement managed process spawning for Julia (stdio transport)
- Add sysimage compilation hint in Settings

### Phase D — Module-contributed definitions

- Parse `languageServers` from module manifests
- Inject into registry on module enable, remove on module disable
- Show module attribution in the Language Servers card

---

## 15. Summary

The design achieves the stated goals:

| Goal                                        | Mechanism                                                   |
|---------------------------------------------|-------------------------------------------------------------|
| Generic — any language supported            | LSP Registry with pluggable definitions                     |
| Module-extensible                           | Module manifest `languageServers` array                     |
| Auto-detect running server                  | Port probe + PATH check in LSPServerManager at startup      |
| User setup in Settings                      | Language Servers tab with per-language status cards         |
| Python uses configured environment          | Detection driven by `config.pythonPath`, not just PATH      |
| Complements existing kernel completions     | Two ranked Monaco completion providers coexist              |
| Fits existing Electron architecture         | Main process owns server lifecycle; renderer owns client    |
| Secure                                      | Loopback-only proxy, no auto-install, managed process scope |
