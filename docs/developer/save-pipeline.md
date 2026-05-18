# Save / Autosave / Clear-Autosave Pipeline

This document maps the end-to-end behavior of PDV's project-persistence
machinery: explicit "Save" / "Save As", the timer-driven autosave, the
in-kernel autosave checksum cache that lets autosaves skip unchanged nodes,
and the various paths that clear autosave state. All line numbers are against
`HEAD` (branch `fix/clear-autosave-cache-eagerly`) at the time of writing.

The pipeline spans three processes:

```
Renderer (React) ──window.pdv──► Main (Electron, TS) ──comm──► Kernel (Python)
```

The kernel's `PDVTree` is the sole data authority. Saves serialize that tree
to disk; the main process owns the filesystem and the timer; the renderer
just triggers things and gates cell execution while a save is in flight.

---

## 1. Explicit save

Triggered by the user (`Save`, `Save As`, or saving into a freshly chosen
directory). One IPC handler in main, one comm message to the kernel, then
a final post-save cleanup hook.

### Renderer → main

`window.pdv.project.save(saveDir, codeCells, projectName?)` resolves to the
`IPC.project.save` channel.

### Main: `IPC.project.save` handler

`electron/main/ipc-register-project.ts` registers a handler that runs the
save under the project-manager save lock so that explicit saves and autosave
ticks queue against each other rather than racing on the kernel's shell
channel. The handler calls `projectManager.save(saveDir, codeCells, ...)`,
then mirrors module-owned files and module manifests into `<saveDir>/modules/`,
and finally fires the `onExplicitSaveCompleted(saveDir)` callback.

Save lock is the same mutex used by autosave — see
`project-manager.ts:585–618` (`runWithSaveLock`).

### Main: `ProjectManager.save()` (`project-manager.ts:339–444`)

1. Ensures `saveDir` exists.
2. Consults `_cachedKernelResults` (line 301) so that a kernel-initiated
   `pdv.save_project()` already in flight isn't re-issued and deadlocked.
3. Otherwise sends `PDVMessageType.PROJECT_SAVE` over the comm router with
   `{ save_dir, is_autosave: false, ... }`.
4. On response, writes `code-cells.json` to `saveDir`.
5. Reads any existing `project.json`, merges in module imports / settings
   coming from the response, and writes the updated `project.json`. This
   is the only path that writes `project.json` to the real save dir;
   autosave never does.

### Kernel: `handle_project_save` (`pdv-python/pdv/handlers/project.py:851–968`)

Registered at `project.py:997`. Behavior:

- Reads `payload.clear_cache` and, if true, resets the module-level
  `_autosave_cache` *before* serializing (`project.py:909–912`). This is the
  fallback path used when the eager `clear_autosave_cache` comm couldn't be
  delivered.
- Calls `serialize_tree_to_dir(tree, save_dir, on_progress=..., autosave_cache=_autosave_cache)`
  (`project.py:947–949`). The cache is **always** passed in — explicit saves
  participate in the same cache as autosaves; the cache is just an XXH3-128
  digest of the node's content keyed by tree path.
- Responds with `node_count`, `checksum`, `autosave_cache_hits`,
  `module_owned_files`, `module_manifests`, and `missing_files`
  (`project.py:963–967`).

### Post-save cleanup (`electron/main/index.ts:641–644`)

```
onExplicitSaveCompleted: (saveDir) => {
  void ProjectManager.clearAutosave(saveDir);
  projectManager.resetAutosaveTimer();
}
```

That is, after a successful explicit save:

- `<saveDir>/.autosave/` is deleted on disk. This prevents the next autosave
  from being a no-op cache hit pointing at a `.autosave/tree/<uuid>/` file
  that the next explicit save would have to relocate or duplicate.
- The autosave timer is restarted from zero so the user gets a full interval
  before the next autosave wakes up.

Note: the kernel-side `_autosave_cache` is **not** cleared here. That is
deliberate — the descriptors in the cache point at the canonical
`<saveDir>/tree/<uuid>/` files that were just written, so they are still
valid and useful for the next autosave's cache hits.

---

## 2. Autosave

Timer-driven, runs against `<baseDir>/.autosave/`, never writes
`project.json` into the real save dir.

### Timer (`project-manager.ts:624–662`)

State:

- `autosaveTimer: ReturnType<typeof setInterval> | null`
- `autosaveIntervalMs` (defaults to 300 s, min 30 s)
- `autosavePending` — set when the kernel was busy at tick time
- `autosaveClearCacheOnNext` — fallback flag for cache invalidation
- `autosaveTickCallback` — the closure to invoke on each tick

`startAutosaveTimer(intervalMs, onTick)` (line 636) creates the interval.
`resetAutosaveTimer()` (line 658) restarts the interval — called after
explicit save. The timer lives in the main process, not the renderer.

### Tick path (`electron/main/index.ts:677–686`)

```
function triggerAutosave(): void {
  if (!activeKernelId) return;
  const state = kernelManager.getExecutionState(activeKernelId);
  if (state !== "idle") {
    projectManager.setAutosavePending();   // deferred until idle
    return;
  }
  win.webContents.send(IPC.push.autosaveTrigger);  // ask renderer for cells
}
```

The renderer needs to be the one to actually send the autosave because it
owns the in-memory `codeCells` snapshot. So main pushes `autosaveTrigger`,
the renderer round-trips by invoking `IPC.autosave.run` with current cells.

If the kernel is busy at tick time, `autosavePending` is set. When the
kernel transitions back to idle, `index.ts:888–896` checks the pending flag
and calls `triggerAutosave()` again.

### `IPC.autosave.run` handler (`index.ts:688–737`)

1. Picks `baseDir` from `activeProjectDir` (if a project is open) or
   `kernelWorkingDirs.get(activeKernelId)` (orphan / untitled).
2. Snapshots in-memory `pendingModuleImports` and `pendingModuleSettings`
   up front so a concurrent `modules:*` IPC can't tear the synthesized
   manifest mid-flight.
3. Acquires `runWithSaveLock` (same mutex as explicit save).
4. Pushes `IPC.push.autosaveStarted` so the renderer gates cell execution
   while the save is in flight.
5. Calls `projectManager.autosave(autosaveDir, codeCells)` where
   `autosaveDir = autosaveDirFor(baseDir)` is `<baseDir>/.autosave/`.
6. Calls `mirrorAutosaveSidecars(autosaveDir, result, ...)` which copies
   module-owned files into `.autosave/modules/`, writes per-module
   manifests, and writes a `project.json` snapshot specifically into
   `.autosave/project.json` for recovery.
7. Pushes `IPC.push.autosaveEnded`.

### `ProjectManager.autosave()` (`project-manager.ts:735–787`)

- Makes `<autosaveDir>/` recursively.
- Reads `this.autosaveClearCacheOnNext` *and clears it* (lines 748–749).
  If set, the upcoming comm carries `clear_cache: true`.
- Sends `PDVMessageType.PROJECT_SAVE` with `save_dir: autosaveDir`,
  `is_autosave: true`, `clear_cache: clearCache`.
- Writes `code-cells.json` directly into the autosave dir.
- Does **not** write `project.json` to the real save dir.
- Logs a one-liner reporting nodes serialized vs. cache hits so the dev
  console reflects cache effectiveness.

The kernel-side handler is the same `handle_project_save`. The only
difference from explicit save is the `save_dir` it receives and the
`is_autosave` flag (which is currently informational only — both paths
go through `serialize_tree_to_dir` with the same `_autosave_cache`).

---

## 3. Autosave cache

The cache is a single module-level dict in the kernel. It is the mechanism
that lets autosaves skip re-serializing unchanged data nodes — without it,
autosave would re-write every file under `.autosave/tree/` on every tick.

### Definition (`pdv-python/pdv/handlers/project.py:41`)

```python
_autosave_cache: dict[str, tuple[bytes, dict]] = {}
```

- **Key**: `tree_path` — the canonical dotted path of the node, e.g.
  `data.runs.001.profiles`.
- **Value**: `(digest, descriptor)`.
  - `digest`: 16-byte XXH3-128 of the node's serialized content (computed
    by `pdv.checksum.node_digest`).
  - `descriptor`: the full node descriptor that would have gone into
    `tree-index.json`, including a `storage.uuid` and `storage.filename`
    pointing at the file that backs the node.

### How the cache is consulted (`pdv-python/pdv/serialization.py:375–411`)

`_try_autosave_cache(autosave_cache, tree_path, value, source_dir, hit_counter, working_dir)`:

1. Computes `digest = node_digest(value, source_dir)`.
2. Looks up `cached = autosave_cache.get(tree_path)`.
3. If `cached[0] == digest`, verifies the descriptor's backing file is
   actually reachable from `working_dir` via `_verify_or_relocate_cached_file`.
   - On success, increments the hit counter and returns
     `(digest, cached_descriptor)`.
   - On failure, drops the stale entry and returns `(digest, None)` so the
     caller re-serializes from scratch. This is the invariant that keeps
     `tree-index.json` from referencing a missing file.
4. On miss, returns `(digest, None)`. Callers then serialize as normal and
   write back: `autosave_cache[tree_path] = (digest, descriptor)`.

The cache is consulted at every "data node" code path in
`serialize_node()` (`serialization.py:630, 658, 713, 797, 814, 836, 862, 881`).

### File relocation (`pdv-python/pdv/serialization.py:284–372`)

`_verify_or_relocate_cached_file(descriptor, working_dir)` is the key
helper introduced by commit a880c60 ("file relocation for autosave cache").

For a `local_file` descriptor (inline `Inline` ones short-circuit to `True`)
it checks four possibilities, in order:

1. **Canonical hit**: `<working_dir>/tree/<uuid>/<filename>` exists →
   return True with no I/O.
2. **Explicit-save adopting an autosave file**: `working_dir` is *not*
   an `.autosave` dir, and the file is found at
   `<working_dir>/.autosave/tree/<uuid>/<filename>`. The helper
   `os.replace()`s it into the canonical location. Same-volume rename is
   effectively free; cross-device (EXDEV) falls back to `shutil.copy2 +
   os.remove`. If both fail, returns False so the caller re-serializes
   rather than emitting a descriptor we can't back.
3. **Autosave reusing a prior explicit save's file**: `working_dir` *is*
   the `.autosave` dir, and the file lives at `<parent>/tree/<uuid>/<filename>`
   from a prior explicit save. No move — the recovery overlay handles
   reading from the parent on load.
4. **Otherwise**: return False; caller re-serializes.

This is why explicit saves do not need to clear the cache: file relocation
guarantees that, by the time `tree-index.json` is written for the explicit
save, the file is at its canonical location, regardless of which save
originally wrote it.

### Cache lifetime

The cache lives only in Python kernel memory. It is invalidated by:

- `clear_cache: true` arriving in a `pdv.project.save` payload
  (`project.py:909–912`) — both the user-facing "Clear autosave data" path
  and the fallback path eventually drive this.
- The `pdv.project.clear_autosave_cache` comm
  (`project.py:970–993`) — the eager path.
- Kernel restart / module reload (it is just a module-level dict).

It is **not** cleared on explicit save, because the descriptors are still
valid and point at the canonical files that were just written.

---

## 4. Clear-autosave

Two distinct things can be "cleared":

- **`.autosave/` on disk** — the staging directory written by autosave
  ticks.
- **The kernel's `_autosave_cache`** — the in-memory dict.

These are independent. The user-facing "Clear autosave data" button does
both. Post-explicit-save cleanup does only the first. Recovery flows clean
up orphans.

### User-initiated: `IPC.autosave.clear` (`electron/main/index.ts:739–749`)

```
ipcMain.handle(IPC.autosave.clear, async (_event, dir?: string) => {
  const target = dir || activeProjectDir || kernelWorkingDirs.get(...);
  if (target) {
    await ProjectManager.clearAutosave(target);    // remove .autosave/ on disk
    await projectManager.clearAutosaveCache();     // eager comm
    projectManager.markAutosaveCacheDirty();       // fallback flag
  }
});
```

The eager + fallback layering is the subject of commit 7525b86 ("eager
clearing of autosave cache to prevent reuse of deleted descriptors"):

- `clearAutosaveCache()` (`project-manager.ts:689–701`) sends
  `PDVMessageType.PROJECT_CLEAR_AUTOSAVE_CACHE` and logs on failure.
- `markAutosaveCacheDirty()` (`project-manager.ts:673–675`) sets
  `autosaveClearCacheOnNext = true` so the next save (autosave or
  explicit) carries `clear_cache: true` even if the comm above didn't
  land (kernel disconnected, busy, etc.).

### Kernel handler: `handle_project_clear_autosave_cache` (`project.py:970–993`)

Calls `clear_autosave_cache()` (resets `_autosave_cache = {}`) and replies
with an empty-payload response. Registered at `project.py:998`.

### Post-explicit-save: `onExplicitSaveCompleted` (`index.ts:641–644`)

Already documented above: deletes `<saveDir>/.autosave/` on disk, does
**not** clear the kernel cache. The 22a9889 commit ("prevent duplication
after explicit saves") is what made this happen unconditionally — before
that, an autosave run shortly after an explicit save could leave duplicate
files under `.autosave/tree/`.

### Orphan recovery

`IPC.autosave.deleteOrphan` (`index.ts:878–...`) and
`IPC.autosave.recoverUnsaved` (`index.ts:768–...`) handle the case where
an unsaved working directory has a `.autosave/` left behind from a previous
crash. Recovery copies files out of the orphan's `.autosave/` into the new
project; deletion just removes the orphan dir. Neither path touches the
in-memory cache (the kernel that produced those files is long gone).

---

## 5. Invariants the recent commits maintain

The three commits this PR train is building on encode the following
invariants. If you change anything in this pipeline, preserve them.

1. **`tree-index.json` never references a missing file.**
   Enforced by `_verify_or_relocate_cached_file` dropping stale entries
   when the backing file can't be located
   (`serialization.py:408–410`).

2. **After explicit save, no duplicate files under `.autosave/tree/`.**
   Enforced by deleting `.autosave/` in `onExplicitSaveCompleted`
   (`index.ts:642`). Without this, an autosave shortly after an explicit
   save would be a cache hit pointing at the canonical file, but the
   `.autosave/tree/<uuid>/` file from the prior autosave would still be
   sitting on disk.

3. **After "Clear autosave data", the cache cannot resurrect deleted files.**
   Enforced by the eager `clearAutosaveCache()` comm
   (`index.ts:746`) plus the `autosaveClearCacheOnNext` fallback
   (`index.ts:747`, `project-manager.ts:748–749`). At least one of the two
   will land before the next save.

4. **Explicit save and autosave never overlap on the kernel shell channel.**
   Enforced by `runWithSaveLock` (`project-manager.ts:608`) wrapping both
   the `IPC.project.save` handler (`ipc-register-project.ts`) and the
   `IPC.autosave.run` handler (`index.ts:707`). ipykernel's shell channel
   serializes requests anyway, but an `execute_request` queued behind a
   `pdv.project.save` can hang in awkward ways — this lock keeps autosaves
   off the wire while an explicit save is running, and vice versa.

5. **`project.json` for the real project lives only at `<saveDir>/project.json`.**
   Autosave writes a `project.json` *snapshot* into `.autosave/project.json`
   (via `mirrorAutosaveSidecars`) for recovery, but never touches the
   parent's `project.json`. The real `project.json` is updated only by
   `ProjectManager.save()` after the kernel response lands
   (`project-manager.ts:436–440`).

6. **Cache descriptors are reused verbatim across saves; only their backing
   file location may need adjustment.** A cache hit always returns the
   exact descriptor dict the cache holds, including its original UUID —
   the relocation step ensures the file is wherever the *consuming*
   `tree-index.json` is about to claim it is.

7. **The "Save → autosave → save" cycle does not allocate new UUIDs for
   unchanged nodes.** Consequence of (6): one explicit save mints the UUID,
   subsequent autosaves are cache hits that reuse it, the next explicit
   save reuses it again (and relocates the file in from `.autosave/` if
   needed).

---

## Summary diagram

```
EXPLICIT SAVE
  Renderer → IPC.project.save
    main: runWithSaveLock(
      → comm pdv.project.save { save_dir, is_autosave: false }
          kernel: serialize_tree_to_dir(save_dir, autosave_cache=_autosave_cache)
                    cache: hit → reuse descriptor, relocate file if needed
                           miss → serialize, write file, store (digest, descriptor)
                  write tree-index.json
      ← response { node_count, checksum, autosave_cache_hits, ... }
      write code-cells.json
      write project.json (merged with prior contents)
      syncModuleOwnedFilesToSaveDir / writeModuleManifestsToSaveDir
    )
    onExplicitSaveCompleted(saveDir):
      ProjectManager.clearAutosave(saveDir)   # rm -rf .autosave/
      projectManager.resetAutosaveTimer()

AUTOSAVE TICK
  main timer → triggerAutosave()
    kernel busy? → autosavePending = true, exit
    otherwise → win.send(IPC.push.autosaveTrigger)
  Renderer → IPC.autosave.run (with codeCells)
    main: runWithSaveLock(
      win.send(autosaveStarted)
      → comm pdv.project.save {
            save_dir: <base>/.autosave/,
            is_autosave: true,
            clear_cache: autosaveClearCacheOnNext (then unset)
          }
          kernel: same handler; mostly cache hits → file relocations or no-ops
      write code-cells.json into .autosave/
      mirrorAutosaveSidecars(autosaveDir, ...):
        copy module files into .autosave/modules/
        write module manifests into .autosave/modules/
        write .autosave/project.json snapshot
      win.send(autosaveEnded)
    )

CLEAR AUTOSAVE (Settings button)
  Renderer → IPC.autosave.clear(dir?)
    main: ProjectManager.clearAutosave(target)  # rm -rf .autosave/
          projectManager.clearAutosaveCache()   # eager: pdv.project.clear_autosave_cache comm
          projectManager.markAutosaveCacheDirty()  # fallback flag
        kernel: _autosave_cache = {}  (either on the eager comm or on the next save)
```
