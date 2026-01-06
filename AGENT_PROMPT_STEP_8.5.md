## Step 8.5: Tree as dynamic namespace + script scaffolding

### Goal
Turn the Tree from a file browser into a data-driven view of the PDV `tree` namespace (Python focus). Nodes only appear when explicitly added (via Python or UI). Add a “Create new script” flow that scaffolds a runnable stub in the configured editor, and render subscriptable objects with expand/collapse plus lightweight previews.

### Requirements
1) **Namespace-backed tree**
   - Tree populates from `tree` (Python kernel) rather than directory listing.
   - Only items explicitly added (via Python or UI) appear.
   - Subscriptable objects (dicts, lists, tuples, sets, arrays, DataFrames) are expandable; non-subscriptables render as leaf rows with type + preview.
   - Scripts are represented as nodes with file path metadata and a `run` action calling their `run(tree, …)`.

2) **Create new script (UI)**
   - Right-click on a tree folder/object → “Create new script”.
   - Prompts for script name; writes a stub file on disk under the corresponding folder path (mirroring tree path).
   - Opens in configured editor (use existing editor config) with stub:
     ```python
     """New PDV script"""
     def run(tree: dict, **kwargs):
         # add your code here
         return {}
     ```
   - On save, script node appears in tree with a preview (first docstring line) and type badges (script/python).

3) **Value rendering**
   - Dicts: children are keys; preview shows count; expandable.
   - Lists/Tuples/Sets: children by index (or capped preview) with length; expandable.
   - Numbers/Strings/Bools/None: leaf row; preview is value (strings truncated); type badge.
   - Arrays: preview shows shape/dtype/min/max if available; expandable if nested; otherwise leaf with metadata.
   - DataFrames/Series: preview shows shape/columns/head summary; expandable columns optional.
   - Scripts: leaf with docstring preview and run/edit actions.

4) **Persistence & paths**
   - Backing storage still on disk; folder structure mirrors tree keys. Creating a script writes a file but tree display remains namespace-driven. (Full save/restore flows can be handled in later steps.)

5) **Actions**
   - Context menu: Run/Edit/Reload for scripts; Refresh subtree; Create new script on folders/objects.
   - Running script injects current `tree` and user params.

6) **Performance**
   - Lazy-load children for large structures; basic paging acceptable.
   - Avoid blocking UI; use async IPC where needed.

### Exit Criteria
- Tree shows only items added via Python (`tree['foo']=...`) or the UI “Create new script” flow; no raw directory listing.
- Expandable containers open/close and show correct children/types/previews.
- “Create new script” creates a stub file on disk, opens editor, and the node appears in the tree with docstring preview and script/python badges.
- Running a script node executes its `run(tree, …)` and updates namespace results.
- Build/tests pass (`npm run build`, `npm test`).

### Files to Modify/Create
- main: namespace query/serialization, script creation handler, config/editor usage
- preload: expose new tree/script methods
- renderer: Tree data model, context menu (create script), ScriptDialog hookup, Console rendering as needed
- styles: any new UI elements

### Notes
- Focus on Python first; Julia can be added later.
- Keep file-backed persistence minimal (stub creation + mirroring path); full save/restore can be a later step.
