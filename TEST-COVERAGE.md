# Test Coverage Reference

**Last run:** 2026-02-23  
**Result:** ✅ 120 passed | 2 skipped | 0 failed  
**Runner:** Vitest (`npm test` from `electron/`)

---

## Summary

| Test File | Suite | Tests |
|-----------|-------|------:|
| `main/app.test.ts` | Project setup | 2 |
| `main/config.test.ts` | Config themes, persistence, validation | 19 |
| `main/file-scanner.test.ts` | FileScanner — all behaviour | 27 |
| `main/index.helpers.test.ts` | IPC helper utilities | 46 |
| `main/kernel-manager.test.ts` | Kernel manager core | 16 |
| `renderer/src/services/tree.test.ts` | Tree service (renderer) | 5 |
| | **Total (passing)** | **120** |

---

## `main/app.test.ts` — Project Setup

Basic smoke tests to confirm the test infrastructure itself works.

| Test | What it checks |
|------|---------------|
| `should have working test infrastructure` | Vitest can run, basic arithmetic and string assertions pass |
| `should be able to import stub modules` | Electron's `ipcMain` stub can be imported without crashing |

---

## `main/kernel-manager.test.ts` — Kernel Manager Core

Tests for the Jupyter wire-protocol helpers and the `KernelManager` class.

### `safeJsonParse`

| Test | What it checks |
|------|---------------|
| `parses valid JSON` | A well-formed JSON string is returned as the parsed object |
| `returns null for invalid JSON` | Malformed JSON returns `null` instead of throwing |
| `returns null when payload exceeds maxSize` | A payload larger than the supplied `maxSize` limit returns `null` |
| `accepts Buffer input` | A Node.js `Buffer` is treated identically to a string |

### `parseMessage`

| Test | What it checks |
|------|---------------|
| `parses a correctly signed message` | A ZMQ message with a valid HMAC-SHA256 signature is parsed and its fields returned |
| `rejects a message with a wrong key` | Using a different signing key causes `parseMessage` to return `null` |
| `rejects a message with a tampered frame` | Modifying any content frame after signing causes `parseMessage` to return `null` |
| `returns null when delimiter is missing` | A frame sequence without the `<IDS|MSG>` delimiter returns `null` |
| `returns null when too few frames follow delimiter` | Fewer than 5 frames after the delimiter returns `null` |
| `round-trips via serializeMessage` | `serializeMessage` → `parseMessage` produces an object equal to the original input |

### `KernelManager`

| Test | What it checks |
|------|---------------|
| `should start with no kernels` | A freshly created `KernelManager` has an empty kernel list |
| `should handle stopping non-existent kernel` | Calling `stop()` with an unknown kernel ID does not throw |
| `execute returns error for non-existent kernel` | `execute()` against an unknown kernel returns `{ error: '...' }` without throwing |

### `Singleton`

| Test | What it checks |
|------|---------------|
| `should return same instance from getKernelManager` | Calling `getKernelManager()` twice returns the exact same object reference |

---

## `main/config.test.ts` — Configuration

Tests for settings persistence, tree-root management, theme storage, and theme validation.

### `config themes` — Tree Root Lifecycle

| Test | What it checks |
|------|---------------|
| `stores themes in ~/.pdv/themes directory and discovers individual files` | `loadThemes` creates `~/.pdv/themes/`, writes default themes, and picks up additional JSON files placed there afterward |
| `creates a timestamped default tree root with standard subdirectories` | First `loadConfig` call generates a `PDV-YYYY_MM_DD_HH:MM:SS/tree` directory under `/tmp/{username}/` and creates `data/`, `scripts/`, `results/` inside it |
| `migrates legacy /tmp/{username}/PDV/tree root to timestamped PDV directory` | A settings file pointing at the old `/tmp/{username}/PDV/tree` path is automatically updated to a new timestamped path |
| `refreshes previously stored timestamped default tree root to a new timestamped directory` | A settings file pointing at a stale timestamped path (e.g. `PDV-2020_01_01_...`) is replaced with a fresh timestamp on load |
| `preserves explicit custom tree root paths from settings` | A non-default path stored in settings is left exactly as-is by `loadConfig` |

### `config persistence`

| Test | What it checks |
|------|---------------|
| `saveConfig writes settings to disk and updates the in-memory cache` | After `saveConfig`, the settings file on disk contains the new values and a subsequent `loadConfig` returns those values from the cache |
| `updateConfig merges a partial config, saves it, and returns the merged result` | `updateConfig({ plotMode: 'inline' })` deep-merges into the current config, writes to disk, and returns the merged object |
| `loadConfig falls back to defaults when settings file contains corrupt JSON` | A syntactically invalid settings file causes `loadConfig` to silently fall back to `DEFAULT_CONFIG` values |
| `loadConfig returns cached result on second call without re-reading disk` | The second call to `loadConfig` returns the exact same object reference as the first, proving it does not re-read the file |

### `config theme validation via loadThemes`

| Test | What it checks |
|------|---------------|
| `skips theme files with corrupt JSON` | A corrupt `.json` file in the themes directory is silently skipped; valid themes are still returned |
| `skips theme files that fail isTheme validation (missing name)` | A JSON file with no `name` property fails the `isTheme` guard and is excluded from the result |
| `skips theme files with empty colors object` | A theme with `colors: {}` fails the `isTheme` guard (must have at least one entry) and is excluded |
| `falls back to DEFAULT_THEMES when all theme files are invalid` | When every file in the themes directory fails validation, `loadThemes` returns the hard-coded default themes (`Dark`, `Light`) |
| `saveTheme uses a filename slug (e.g. "My Theme!" → my-theme-.json)` | The theme name is lowercased, non-alphanumeric chars replaced with `-`, and leading/trailing dashes stripped to produce the file name |

---

## `main/file-scanner.test.ts` — File System Scanner

Tests for `FileScanner` — the class that walks `tree/` and builds the `TreeNode` hierarchy.

### `FileScanner` — Core Scan

| Test | What it checks |
|------|---------------|
| `scans tree and extracts script metadata` | Full `scanAll` → `getChildren` → node inspection flow: confirms correct node path, type, language, `_file_path`, and `preview` docstring for a Python script |

### `FileScanner.scanAll` — Directory Creation

| Test | What it checks |
|------|---------------|
| `creates data/scripts/results subdirs when treeRoot does not exist` | When given a non-existent root path, `scanAll` creates the root plus the three standard subdirectories |

### `FileScanner hidden files`

| Test | What it checks |
|------|---------------|
| `excludes hidden files by default (includeHidden: false)` | Files and directories whose names start with `.` are absent from the returned nodes when `includeHidden` is not set |
| `includes hidden files when includeHidden: true` | Passing `{ includeHidden: true }` to the constructor causes hidden files to appear in the scan results |

### `FileScanner file type detection`

Each test places a real file in a temp directory and verifies that the scanner sets the correct `type` (and `loaderHint` where applicable).

| Test | Expected `type` |
|------|----------------|
| `dataset.h5` | `hdf5` (loaderHint: `hdf5`) |
| `dataset.hdf5` | `hdf5` (loaderHint: `hdf5`) |
| `data.zarr` | `zarr` (loaderHint: `zarr`) |
| `table.parquet` | `parquet` (loaderHint: `parquet`) |
| `array.npy` | `npy` (loaderHint: `npy`) |
| `compressed.npz` | `npy` (loaderHint: `npy`) |
| `image.png` | `image` (loaderHint: `image`) |
| `photo.jpg` | `image` (loaderHint: `image`) |
| `drawing.svg` | `image` (loaderHint: `image`) |
| `config.json` | `config` |
| `settings.yaml` | `config` |
| `notes.toml` | `config` |
| `readme.txt` | `text` |
| `readme.md` | `text` |
| `unknown.bin` | `file` (catch-all) |

### `FileScanner script node properties`

| Test | What it checks |
|------|---------------|
| `sets type=script and language=python for .py files` | A `.py` file gets `type='script'`, `language='python'`, and an `actions` array containing `'run'` and `'edit'` |
| `sets type=script and language=julia for .jl files` | A `.jl` file gets `type='script'` and `language='julia'` |

### `FileScanner docstring extraction`

| Test | What it checks |
|------|---------------|
| `extracts Python module docstring` | A `"""..."""` at the top of a `.py` file is used as the node's `preview` field |
| `extracts Python run() docstring when no module docstring` | When there is no module docstring, the docstring inside `def run(...)` is used as `preview` |
| `returns no preview for Python script with no docstring` | A `.py` file with no docstrings at all results in `preview` being `undefined` |
| `extracts Julia module docstring` | A `"""..."""` at the top of a `.jl` file is used as `preview` |
| `extracts Julia run() docstring` | A `"""..."""` immediately before `function run(` in a `.jl` file is used as `preview` |

### `FileScanner.getChildren edge cases`

| Test | What it checks |
|------|---------------|
| `returns empty array for a non-existent path` | Calling `getChildren('does.not.exist')` returns `[]` without throwing |
| `returns empty array for a path pointing to a file, not a directory` | Calling `getChildren` on a path that resolves to a file (not a directory) returns `[]` |

---

## `main/index.helpers.test.ts` — IPC Helper Utilities

Tests for helper functions exported from the Electron main-process IPC layer.

### `index helper utilities` — `pickKernelForScriptReload`

| Test | What it checks |
|------|---------------|
| `prefers requested language when present` | When a kernel matching the requested language exists, it is returned |
| `falls back to first kernel if preferred missing` | When no kernel matches the preferred language, the first kernel in the array is returned |
| `returns null for empty array` | An empty array returns `null` |
| `returns null for non-array input` | Passing `null` (or any non-array) returns `null` without throwing |
| `returns first when no preference given` | Called without a language preference, the first kernel is returned |

### `index helper utilities` — `normalizeWatchPath`

| Test | What it checks |
|------|---------------|
| `returns resolved path only for existing path` | An existing directory is returned as its `path.resolve`-d form; a missing sibling path returns `null` |
| `rejects non-string input` | `null` and numeric values return `null` instead of throwing |
| `rejects path with control characters` | Paths containing ASCII control characters (`\x00`–`\x1F`) return `null` |
| `rejects empty string` | An empty string or whitespace-only string returns `null` |

### `index helper utilities` — `getPythonFirstScriptCompatibilityError`

| Test | What it checks |
|------|---------------|
| `blocks julia script with python-only policy` | A Julia script language triggers an error message about Julia scripts not yet being supported |
| `blocks julia kernel with python-only policy` | A Julia kernel language triggers an error message about Julia kernel execution |
| `allows python script on python kernel` | Python script + Python kernel returns `null` (no error) |

### `validateFilePath`

| Test | What it checks |
|------|---------------|
| `accepts a path inside the allowed root` | A path inside the allowed root returns its resolved absolute path |
| `accepts the root itself` | The root directory itself is a valid path |
| `rejects a path that traverses above the root` | `../../../etc/passwd`-style traversal returns `null` |
| `rejects an absolute path outside the root` | `/etc/passwd` (outside the root) returns `null` |
| `rejects empty string` | An empty string input returns `null` |
| `rejects non-string input` | `null` returns `null` without throwing |
| `rejects encoded traversal (../../)` | A path like `root/foo/../../etc/passwd` that resolves outside the root returns `null` |

### `sanitizeScriptName`

| Test | What it checks |
|------|---------------|
| `returns null for empty string` | An empty string input returns `null` |
| `returns null for whitespace-only string` | A whitespace-only string returns `null` after trimming |
| `allows simple alphanumeric names` | `my_analysis` passes through unchanged |
| `converts spaces to underscores` | `my analysis` → `my_analysis` |
| `trims surrounding whitespace` | Leading/trailing spaces are stripped before processing |
| `rejects names containing forward slash` | `scripts/evil` returns `null` (path separator injection) |
| `rejects names containing backslash` | `scripts\evil` returns `null` |
| `rejects names containing special shell characters` | `<`, `>`, `\|`, `?`, `*` each individually return `null` |
| `rejects names longer than 200 characters` | A 201-character name returns `null` |
| `accepts names at exactly 200 characters` | A 200-character name is the maximum permitted length |
| `allows dots and dashes` | `my-script.v2` is a valid name |
| `rejects unicode characters not in the allowed set` | `analyse_données` (accented character) returns `null` |

### `parseDefaultValue`

| Test | What it checks |
|------|---------------|
| `parses Python True as boolean true` | Both `'True'` and `'true'` are returned as JS `true` |
| `parses Python False as boolean false` | Both `'False'` and `'false'` are returned as JS `false` |
| `parses integer strings as numbers` | `'42'`, `'-7'`, `'0'` are returned as numbers |
| `parses float strings as numbers` | `'3.14'`, `'-0.5'` are returned as numbers |
| `strips double quotes from string literals` | `'"hello"'` → `'hello'` |
| `strips single quotes from string literals` | `"'world'"` → `'world'` |
| `returns unquoted bare strings as-is (trimmed)` | `'  myvalue  '` → `'myvalue'` |
| `handles whitespace around values` | `'  42  '` → `42`, `'  True  '` → `true` |

---

## `renderer/src/services/tree.test.ts` — Tree Service (Renderer)

Tests for the renderer-side `treeService`, which caches `TreeNode` data fetched via the `window.pdv.tree` IPC bridge (mocked in tests).

| Test | What it checks |
|------|---------------|
| `loads and caches root nodes` | First call to `getRootNodes` invokes `window.pdv.tree.list` once; the second call returns the same array reference from cache. Returned nodes have `isExpanded: false` and `isLoading: false` |
| `returns empty array when node has no children` | `getChildren` on a node with `hasChildren: false` returns `[]` and does not call the IPC list method |
| `loads and caches children by path` | First `getChildren` call for a given path calls the IPC list; the second returns the cached array without another call |
| `maintains cache per kernel` | The same parent node fetched for two different kernel IDs results in two separate IPC calls (separate caches per kernel) |
| `creates script and clears cache` | `createScript` calls `window.pdv.tree.createScript`, and the root-node cache is invalidated so the next `getRootNodes` call re-fetches |
