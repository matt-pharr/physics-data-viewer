# PDV Upcoming Features and Gaps

This document lists features that are **not yet fully implemented** and highlights design/implementation issues that should be addressed as PDV evolves toward production use.

---

## 1) Project Save/Open System (Major Missing Capability)

## What is missing
- No first-class directory project format contract (manifest + index)
- No explicit Save / Save As / Open project UX
- No project manifest capturing tree metadata, command tabs, runtime settings, module state
- No schema versioning or migration strategy

## Why it matters
Without a project contract, reproducibility and long-term compatibility are fragile, especially when workflows become community-shared.

## Proposed direction
- Define `project.json` manifest with schema version
- Store references to tree data assets (not always inline data)
- Persist command tabs and active tab as project state
- Persist module enablement and per-module configuration
- Add migration handlers for older project versions

## Decision for now
- Use **directory-only persistence** as the primary and only save mode in the near term.
- Do not implement mandatory zip/single-archive open flow for large projects.

---

## 2) Unified Tree Persistence + Data Authority

## What is missing
- Tree listing is currently pulled from kernel snapshot (`pdv_tree_snapshot`)
- Script resolution/editing uses filesystem scanning (`FileScanner`)
- `tree:get` and `tree:save` IPC handlers are stubs
- No canonical sync protocol between in-memory tree and on-disk assets

## Why it matters
Different sources of truth can drift and produce confusing user behavior (e.g., tree view and filesystem actions disagreeing).

## Proposed direction
- Establish canonical tree model with explicit persistence lifecycle
- Define node identity that survives restarts
- Implement `tree:get`/`tree:save` for value-level operations
- Add consistency rules for memory-vs-disk nodes

## Protocol intent (clarified)
- `tree:list(path)`: return children + metadata only (fast browse, no heavy payload)
- `tree:get(id, options)`: materialize node value/preview/slice lazily when UI requests it
- `tree:save(id, value)`: persist updated node payload and/or node metadata

## Python-functional framing
- Kernel remains the primary source of truth for tree semantics and data loading.
- Persisted nodes that have disk backing should carry project-relative paths.

## v1 persistence behavior (now scoped)
- Everything in the tree is persisted as project state.
- Lazy-loading priority classes: NumPy arrays, Pandas DataFrame/Series, HDF5/Zarr/Parquet references, and large/custom binary objects.
- Runtime is memory-primary; lazy-backed nodes hydrate on demand.
- Mutation writes can go to a project working directory for fast recovery.
- Explicit Save/Save As performs a durable project checkpoint.

---

## 3) True Lazy Loading for Large Data

## What is missing
- No complete lazy adapter layer for large file-backed datasets
- No chunked/sliced read strategy exposed end-to-end in UI
- No formal cache policy for large object previews

## Why it matters
Target users handle datasets in 100GB+ range; full materialization is not feasible.

## Proposed direction
- Implement backend node adapters for HDF5/Zarr/Parquet/Numpy with metadata-first browsing
- Add paged/chunked APIs in IPC and tree nodes
- Cache small previews while keeping heavy data out of renderer process

---

## 4) Modules System (UI + Runtime)

## What is missing
- Modules tab is currently a placeholder
- No module manifest schema
- No module discovery/install/enable lifecycle
- No action/button binding from UI to module scripts
- No per-module settings or compatibility checks

## Why it matters
Modules are central to the community workflow vision and reuse of domain-specific analysis pipelines.

## Proposed direction
- Introduce module manifest (name/version/actions/dependencies/views)
- Build module registry and local module installation model
- Bind module actions to kernel script execution endpoints
- Add module health checks and compatibility metadata

---

## 5) Full Julia Support (Parity Work)

## What is missing
- UI startup path is Python-biased (kernel start config hardcoded to Python launcher)
- Script run/reload handlers enforce Python-only compatibility checks
- Julia tests are scaffold-only (not implemented)

## Why it matters
Final product goal requires project-level language choice and confidence in both runtimes.

## Proposed direction
- Add language selection at project creation/open
- Implement script create/run/reload parity for Julia
- Add robust Julia integration tests comparable to Python tests

---

## 6) Remote Execution / Remote Data Access

## What is missing
- No remote kernel transport abstraction
- No SSH/tunneled or gateway-based remote session model
- No remote data connector abstraction
- No auth/session management for remote resources

## Why it matters
Remote compute and data access are essential for institutional/HPC workflows and very large datasets.

## Proposed direction
- Define backend execution transport interface (`local`, `remote`)
- Add remote kernel lifecycle manager
- Implement remote filesystem/data provider plugins
- Add reconnect/recovery behavior and session credentials policy

## Priority decision
- Prioritize **remote data connectors** before remote kernel execution.
- First connector target should be **SSH/SFTP**.

---

## 7) Rich Document Artifacts in Tree (Markdown/PDF workflow)

## What is missing
- File type detection includes text-like files, but no dedicated markdown/PDF workflow UX
- No integrated markdown editor/preview or PDF viewer actions in UI
- No explicit research-note workflow in project metadata

## Why it matters
Analysis is not only code+data; teams need interpretation and notes in the same project space.

## Proposed direction
- Add node actions for markdown preview/edit and PDF open/view
- Treat documents as first-class tree assets with metadata and indexing

---

## 8) Command Box and Execution Persistence Model

## What is missing
- Command box tabs persist to a standalone `command-boxes.json`
- No association yet with formal project versioning/schema
- No optional capture of execution metadata/history replay model

## Why it matters
Notebook-like workflows are core; persistence should be integrated with project lifecycle.

## Proposed direction
- Move command box state under project manifest ownership
- Add optional execution timeline serialization (configurable)
- Support session restore/recovery behavior

---

## 9) Tree Watchers and Hot Reload UX

## What is missing
- File watch API exists but renderer event bridge is TODO
- No visible user feedback for watched-file updates
- No conflict resolution for external file edits during active sessions

## Why it matters
External editor usage is already part of script workflows; reload signaling should be reliable.

## Proposed direction
- Push watch events to renderer via subscription channel
- Add stale/changed indicators on nodes
- Provide reload/merge choices when applicable

---

## 10) Data Loading and Type-specific Actions

## What is missing
- File scanner assigns loader hints/actions for formats (HDF5, Zarr, Parquet, NPY), but concrete loading paths are still limited
- No full inspector UX for large multidimensional data

## Why it matters
Type recognition alone is not enough; users need robust lazy read + preview/edit workflows.

## Proposed direction
- Build per-format loader backends with shared lazy interface
- Add table/array inspectors with paging and statistics on demand

---

## 11) Security, Trust, and Operational Guardrails

## What is missing / risk areas
- No mature trust model around script/data provenance
- No project-level permissions/sandbox policy for module execution
- Limited audit trail for who ran what and when

## Why it matters
As module and remote features arrive, risk surface expands rapidly.

## Proposed direction
- Introduce trust levels for projects/data/modules
- Add optional signed modules or allowlist policies
- Track execution metadata for reproducibility and audits

---

## 12) Testing and Quality Expansion

## What is missing
- End-to-end integration tests across renderer ↔ main ↔ live kernels are limited
- Julia backend tests not implemented
- No broad regression tests for persistence format evolution

## Why it matters
Feature growth without stronger test coverage will increase breakage risk, especially across language/runtime boundaries.

## Proposed direction
- Add E2E smoke tests for kernel startup, execution, tree load, script run, save/open
- Add parity test suite for Julia
- Add fixture projects and migration tests for project schema upgrades

---

## 13) Known Design/Implementation Issues to Address

These are current implementation choices likely to create future friction if left unchanged.

1. **Split tree authority**
- Kernel snapshot and filesystem scanner both drive behavior; should be unified.

2. **Stubbed tree APIs**
- `tree:get` and `tree:save` currently not real implementations.

3. **Python-centric hardcoding in app startup path**
- Conflicts with eventual dual-language parity objective.

4. **Script parameter introspection via regex**
- Fragile for advanced signatures; AST/introspection-based parsing would be more reliable.

5. **Dot-delimited tree paths**
- Keys containing dots are awkward and can collide with path semantics.

6. **Temp-root default project location**
- Timestamped `/tmp` roots are useful for development but not ideal as durable project UX default.

7. **Partial file read contract mismatch**
- `files.read` API accepts options (start/end/encoding) but implementation currently returns full UTF-8 content.

8. **Watchers without UI event consumption**
- Infrastructure exists but no complete UX loop.

---

## 14) Suggested Priority Order

Recommended implementation sequence:

1. Project format + save/open + schema versioning
2. Unified tree model + real `tree:get`/`tree:save`
3. Large-data lazy loading primitives
4. SSH/SFTP remote data connector foundation
5. Module manifest/runtime + Modules UI
6. Julia parity implementation + tests
7. Remote execution architecture
8. Document artifacts (Markdown/PDF) and integrated viewer/editor workflow

---

## 15) Definition of “Feature Complete” (relative to current vision)

PDV can be considered close to the described target when all of the following are true:
- Projects open/save reliably with complete state
- Tree is persistent, scalable, and lazily browsable for large datasets
- Command box state is project-managed and recoverable
- Modules are installable/editable/runnable via manifest-driven UI actions
- Python and Julia have practical parity for core workflows
- Remote execution and remote data access are production-usable
- Markdown/PDF artifacts integrate naturally into the tree workflow
