# QUESTIONS

## 1) Feature-priority and sequencing
1. Should the next milestone be to **finish partial Steps 6/7/8** before beginning Step 9 loaders?
2. Should Step completion be tracked by capability checklists rather than by step labels only, since implementation is non-linear?

## 2) Plot behavior (Step 6 hardening)
1. In capture mode, should **all** display-capable outputs (PNG/SVG/HTML/JSON) be rendered, or should console prioritize image-only first?
2. Should capture mode also handle `update_display_data` and multi-output cell streams explicitly?
3. For native mode, what is the expected fallback if no GUI backend is available (error, warning, or auto-fallback to capture)?
4. Should Julia and Python plot behavior be kept strictly equivalent in UX (button labels, output format preference, close behavior)?

## 3) Namespace UX semantics (Step 7)
1. What should double-click on namespace variables do by type:
   - array/dataframe => preview panel?
   - scalar => copy value?
   - plot object => render?
2. Should namespace refresh be polling-only, event-driven, or hybrid?
3. How much metadata is required for large objects before namespace queries become too expensive?

## 4) Scripts and reload semantics (Step 8)
1. What should `script:reload` mean exactly for Python and Julia?
   - Python: `importlib.reload`, re-import by file hash, or execute fresh module each run?
   - Julia: Revise-driven reload vs include-per-run behavior?
2. Should external file changes trigger automatic rerun, or prompt user first?
3. Should scripts be permitted only under `tree/scripts/`, or can they be linked from outside project root?
4. Should parameter extraction move from regex to AST parsing for robustness?

## 5) Tree API and persistence model (Step 10)
1. Should `tree.get/save` operate on kernel-memory objects, filesystem-backed objects, or both?
2. For arbitrary objects, what is the canonical serialization strategy:
   - Python: pickle only, or pluggable codecs?
   - Julia: JLSO/JLD2 only, or pluggable codecs?
3. How should trust model work for deserialization in UI and IPC (per-project trust, per-file trust, signed manifests)?
4. Should blob storage be content-addressed globally across projects or per-project?

## 6) Data loader architecture (Step 9)
1. Should loaders execute inside kernel runtime only, or can main process perform metadata extraction for certain formats?
2. What is the desired abstraction boundary: one unified loader API in init scripts vs split Python/Julia loader registries?
3. For very large files, should previews be sampled in main process, kernel process, or deferred entirely until explicit user action?
4. What is minimum viable loader set for first usable milestone (HDF5 + NPY first?)

## 7) Module system (Steps 11/12)
1. Should module manifests be kernel-owned (registered dynamically) or project-owned files persisted on disk?
2. How much reactivity is required in Phase 1 (submit-on-click only vs live two-way binding)?
3. Should widget schema be language-agnostic and map to Python/Julia backends, or support language-specific extensions?
4. What security boundaries are required for manifest-triggered code execution?

## 8) IPC and maintainability
1. Should preload IPC constants be generated/imported to eliminate duplication with `main/ipc.ts`?
2. Should `main/index.ts` be split into per-domain handler modules (kernels/tree/scripts/files/config)?
3. Is there a preferred logging strategy for production (structured logs, levels, log file location)?

## 9) Cross-platform behavior
1. External editor command defaults currently assume macOS-style `open`; what should be default behavior on Linux/Windows?
2. Should executable validation and launch path handling enforce stricter platform-specific sanitization?

## 10) Test strategy
1. Which integration tests are highest priority next:
   - IPC integration tests,
   - end-to-end script run/edit/reload flow,
   - plot capture end-to-end,
   - namespace correctness?
2. Should real-kernel tests be expanded in CI, or remain opt-in due environment variability?

