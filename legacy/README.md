# Legacy Code

This directory contains the pre-rewrite implementation of PDV, archived before the v0.0.1 architectural rewrite described in `ARCHITECTURE.md`.

**Do not import from or build this code.** It is kept for reference only.

## Why it was replaced

The old architecture had the following structural problems:

- The Electron main process constructed Python source code strings and sent them via `execute_request`, creating an implicit, unversioned contract between TypeScript and Python with no type safety.
- The `FileScanner` introduced a second tree authority that could silently diverge from the live kernel tree.
- Julia was structurally excluded from tree operations by Python-specific code paths in the IPC handlers.
- `python-init.py` was a 1200-line monolith with no enforced interface boundary.

The replacement is described in full in `ARCHITECTURE.md`.
