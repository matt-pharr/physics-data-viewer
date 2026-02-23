# PDV v1 Schema and Persistence Design

Status: Draft v1 (implementation-oriented)
Scope: Directory-only projects, Python-kernel-authoritative tree, lazy loading for large data classes, explicit Save checkpoints.

---

## 1. Goals and non-goals

## Goals
- Define a concrete, versioned project directory layout.
- Define stable on-disk schemas for project metadata and tree index.
- Define IPC payload contracts for tree:list, tree:get, tree:save.
- Support very fast open for large projects by loading only metadata initially.
- Keep architecture Julia-ready while implementing Python-first.

## Non-goals (v1)
- No single-file bundle as primary format.
- No mandatory zip-based open flow.
- No remote kernel execution in v1.
- No complete module system implementation in this spec (schema hooks only).

---

## 2. Project directory layout (directory-only)

Each project is a folder with this minimum structure:

- project-root/
  - project.json
  - tree-index.json
  - command-boxes.json
  - tree/
    - data/
    - scripts/
    - results/
  - .pdv-work/
    - autosave/
    - journal/
    - cache/

Notes:
- project.json and tree-index.json must be sufficient to open a project quickly.
- .pdv-work is internal mutable state for recovery/performance; explicit Save checkpoints durability.
- All persisted tree-backed file paths are relative to tree/ unless explicitly marked as remote.

---

## 3. project.json schema (v1)

## 3.1 Semantics
- Primary project manifest.
- Must include schema version.
- Must include enough metadata to initialize UI and kernel session context.

## 3.2 Required fields
- schema_version: string, fixed in v1 as 1.0.0
- project_id: stable UUID string
- project_name: string
- created_at: ISO datetime
- updated_at: ISO datetime
- language_mode: python | julia (default python in v1 implementation)
- persistence_mode: directory
- tree_root: string, normally tree
- tree_index_file: string, normally tree-index.json
- command_boxes_file: string, normally command-boxes.json

## 3.3 Optional fields
- kernel:
  - preferred_spec: string | null
  - python_path: string | null
  - julia_path: string | null
- ui:
  - theme_name: string | null
  - appearance_colors: map<string,string>
- modules:
  - enabled: array<string>
  - config: map<string,object>
- remote_connectors:
  - entries: array<RemoteConnectorRef>
- notes:
  - description: string
  - tags: array<string>

## 3.4 Example

```json
{
  "schema_version": "1.0.0",
  "project_id": "0e578ae1-4147-46cf-94f2-8b6c8ab5929d",
  "project_name": "DIII-D Resistive Study",
  "created_at": "2026-02-23T12:00:00Z",
  "updated_at": "2026-02-23T12:45:00Z",
  "language_mode": "python",
  "persistence_mode": "directory",
  "tree_root": "tree",
  "tree_index_file": "tree-index.json",
  "command_boxes_file": "command-boxes.json",
  "kernel": {
    "preferred_spec": "python3",
    "python_path": "/usr/bin/python3",
    "julia_path": null
  },
  "ui": {
    "theme_name": "Dark",
    "appearance_colors": {
      "bg-primary": "#1e1e1e"
    }
  },
  "modules": {
    "enabled": [],
    "config": {}
  },
  "remote_connectors": {
    "entries": []
  }
}
```

---

## 4. tree-index.json schema (v1)

## 4.1 Semantics
- Metadata-only index for all tree nodes.
- Fast to load and parse.
- No large payload blobs.

## 4.2 Top-level fields
- schema_version: string, 1.0.0
- root_path: string, usually empty string for root
- node_count: integer
- nodes: array<TreeNodeRecord>
- checkpoints:
  - last_saved_at: ISO datetime
  - autosave_seq: integer

## 4.3 TreeNodeRecord fields
Required:
- id: stable node id string (not display label)
- path: dot path (v1 compatibility) e.g. data.signals.ip
- key: display key
- parent_path: string | null
- kind: enum (see below)
- storage: StorageRef
- lazy: boolean
- has_children: boolean
- created_at: ISO datetime
- updated_at: ISO datetime

Optional metadata:
- shape: array<number>
- dtype: string
- size_bytes: number
- preview: string
- language: python | julia (for scripts)
- actions: array<string>
- tags: array<string>
- user_meta: object

Kind enum (v1):
- folder
- script
- scalar
- mapping
- sequence
- ndarray
- dataframe
- series
- dataset_ref
- binary
- text
- unknown

## 4.4 StorageRef
Required:
- backend: local_file | remote_ssh_sftp | inline_small
- relative_path: string | null
- format: py_pickle | npy | npz | parquet | hdf5 | zarr | json | txt | py_script | binary | remote_ref

Optional:
- remote_ref_id: string | null
- remote_uri: string | null
- compression: none | gzip | zstd
- chunking: object | null
- trusted: boolean
- checksum: string | null
- serializer: string | null

Rules:
- If backend is local_file, relative_path is required and must resolve under tree/.
- If backend is remote_ssh_sftp, remote_ref_id is required and relative_path can be null.
- inline_small is only for tiny metadata values; not for large arrays/dataframes.

## 4.5 Example

```json
{
  "schema_version": "1.0.0",
  "root_path": "",
  "node_count": 3,
  "checkpoints": {
    "last_saved_at": "2026-02-23T12:45:00Z",
    "autosave_seq": 17
  },
  "nodes": [
    {
      "id": "n_data_signals_ip",
      "path": "data.signals.ip",
      "key": "ip",
      "parent_path": "data.signals",
      "kind": "ndarray",
      "storage": {
        "backend": "local_file",
        "relative_path": "data/signals/ip.npy",
        "format": "npy",
        "compression": "none",
        "trusted": true
      },
      "lazy": true,
      "has_children": false,
      "shape": [20000000],
      "dtype": "float64",
      "size_bytes": 160000000,
      "preview": "float64 (20000000)",
      "created_at": "2026-02-23T12:00:00Z",
      "updated_at": "2026-02-23T12:40:00Z"
    },
    {
      "id": "n_scripts_fit_model",
      "path": "scripts.fit_model",
      "key": "fit_model",
      "parent_path": "scripts",
      "kind": "script",
      "storage": {
        "backend": "local_file",
        "relative_path": "scripts/fit_model.py",
        "format": "py_script",
        "trusted": true
      },
      "lazy": false,
      "has_children": false,
      "language": "python",
      "actions": ["run", "edit", "reload"],
      "created_at": "2026-02-23T12:02:00Z",
      "updated_at": "2026-02-23T12:35:00Z"
    },
    {
      "id": "n_data_remote_shot",
      "path": "data.remote.shot12345",
      "key": "shot12345",
      "parent_path": "data.remote",
      "kind": "dataset_ref",
      "storage": {
        "backend": "remote_ssh_sftp",
        "relative_path": null,
        "format": "remote_ref",
        "remote_ref_id": "r1",
        "remote_uri": "sftp://server/path/to/file.h5"
      },
      "lazy": true,
      "has_children": false,
      "created_at": "2026-02-23T12:10:00Z",
      "updated_at": "2026-02-23T12:10:00Z"
    }
  ]
}
```

---

## 5. command-boxes.json schema (v1)

Retain current shape for compatibility:

- tabs: array<{id:number, code:string}>
- activeTabId: number

Optional v1 additions:
- updated_at: ISO datetime
- language_mode: python | julia

---

## 6. IPC contracts for tree:list, tree:get, tree:save

## 6.1 tree:list
Request:
- kernelId: string
- path: string (empty for root)

Response:
- array of TreeNode UI metadata (no heavy payload)

Behavior:
- Must not materialize large node data.
- Reads from kernel registry backed by tree-index metadata.

## 6.2 tree:get
Request:
- id: string
- options:
  - mode: metadata | preview | value | slice
  - slice: optional object for arrays/tables
  - columns: optional array for dataframe projection
  - trusted: boolean

Response envelope:
- success: boolean
- node_id: string
- mode: metadata | preview | value | slice
- value: unknown | null
- metadata: object
- error: string | null

Behavior:
- metadata mode: return index metadata only.
- preview mode: return bounded-size preview.
- value mode: materialize full value only if safe/allowed.
- slice mode: return projected subset for large objects.

## 6.3 tree:save
Request:
- id: string
- value: unknown
- options:
  - write_mode: replace | merge | append
  - sync: immediate | deferred

Response envelope:
- success: boolean
- node_id: string
- updated_at: ISO datetime
- storage: StorageRef
- error: string | null

Behavior:
- Writes node payload/metadata to working directory.
- Updates in-memory kernel registry immediately.
- Marks project dirty until explicit Save checkpoint.

---

## 7. Save, autosave, and open semantics (v1)

## 7.1 Working writes
- Mutations may write to project-root/.pdv-work/autosave and/or target tree files.
- Journal entries in .pdv-work/journal allow recovery.

## 7.2 Explicit Save
- Flush registry to tree-index.json.
- Flush command boxes to command-boxes.json.
- Promote autosave state to durable checkpoint.
- Update project.json updated_at.

## 7.3 Open
- Read project.json and tree-index.json first.
- Initialize kernel tree registry from index only.
- Defer heavy object materialization until tree:get calls.

---

## 8. Path and safety rules

- All local persisted paths are relative and normalized under tree/.
- Reject path traversal (.., absolute paths when relative required).
- Preserve display path separately from storage path.
- Dot path is accepted in v1 for compatibility; reserve future support for escaped keys.

---

## 9. Julia-readiness constraints

Even with Python-first implementation:
- Keep node kind/storage schemas language-neutral.
- Keep script node language explicit.
- Keep serialization metadata explicit (serializer field) to allow Julia serializers.
- Avoid Python-only assumptions in project.json top-level fields.

---

## 10. Remote connector schema hook (SSH/SFTP first)

RemoteConnectorRef in project.json remote_connectors.entries:

- id: string
- type: ssh_sftp
- name: string
- host: string
- port: number
- username: string
- auth: key | agent | password_ref
- root_paths: array<string>
- options:
  - connect_timeout_sec: number
  - verify_host_key: boolean

Credentials are not stored in plain project files; use OS keychain or external secret reference.

---

## 11. Migration and compatibility

- Strict schema_version checks on open.
- Provide migration stubs for 1.x minor upgrades.
- Reject unknown major versions with actionable error.

---

## 12. Acceptance criteria for v1 schema implementation

- Project open for large projects does not materialize full arrays/dataframes by default.
- tree:list returns metadata only and is fast.
- tree:get supports metadata/preview/value/slice modes.
- tree:save updates registry and storage correctly.
- Explicit Save writes project.json, tree-index.json, command-boxes.json consistently.
- Relative path safety validation prevents path escape.
- Existing command-box persistence remains backward compatible.
