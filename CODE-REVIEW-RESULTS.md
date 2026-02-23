# 📋 Code Review: Physics Data Viewer

> Reviewed: 2026-02-23  
> Reviewer: GitHub Copilot (Claude Sonnet 4.6)  
> Scope: `electron/main/` + `electron/preload.ts` + `electron/renderer/src/app/index.tsx`

---

## 🔴 Critical Issues — Must fix before merge

### 1. Message Signature Validation Disabled
**`electron/main/kernel-manager.ts:172`**

HMAC signature verification is commented out (`// Skip signature validation for now`). Outgoing messages are signed but incoming ones are never verified, allowing potential message injection on the ZMQ ports.

**Fix:** Compute HMAC over the 4 wire frames and compare against the received signature before parsing:
```typescript
const hmac = crypto.createHmac('sha256', key);
hmac.update(header).update(parentHeader).update(metadata).update(content);
if (hmac.digest('hex') !== receivedSig) return null;
```

---

### 2. Unbounded JSON Parsing — DoS Risk
**`electron/main/kernel-manager.ts:173-176`, `electron/main/index.ts:782`**

`JSON.parse()` is called on untrusted kernel output and user-controlled files with no size limit. A malicious kernel or a corrupted `command-boxes.json` could freeze the main process.

**Fix:** Add a `safeJsonParse` helper that rejects inputs above a threshold (e.g., 10MB):
```typescript
function safeJsonParse<T>(data: string | Buffer, maxSize = 10_485_760): T | null {
  const str = typeof data === 'string' ? data : data.toString();
  if (str.length > maxSize) return null;
  try { return JSON.parse(str); } catch { return null; }
}
```

---

### 3. Path Traversal in `files:read` / `files:write`
**`electron/main/index.ts:618-656`**

Both handlers accept arbitrary file paths from the renderer with **no validation against the project root**. Any code running in the renderer can read `/etc/passwd` or overwrite arbitrary files.

**Fix:** Resolve paths and assert they stay within the configured `treeRoot`:
```typescript
const resolved = path.resolve(filePath);
const relative = path.relative(path.resolve(allowedRoot), resolved);
if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
```

---

### 4. Command Injection Risk in `openInEditor`
**`electron/main/index.ts:994-1024`**

User-controlled file paths are substituted into editor command strings. While `shell: false` is already used (good!), there is no validation that the path is within the project, leaving room for exploitation via crafted paths.

**Fix:** Run a `validateFilePath` check (same as Issue #3) before constructing the `args` array.

---

### 5. Race Condition in Kernel Execution
**`electron/main/kernel-manager.ts:549-702`**

`waitForAvailability` uses a busy-wait loop with a TOCTOU gap — two concurrent `execute()` calls can both pass the `managed.executing === false` check before either sets it to `true`. This can corrupt ZMQ socket state.

**Fix:** Use a `Map<string, Promise<void>>` as a proper per-kernel mutex:
```typescript
// Acquire
while (this.executionLocks.has(id)) await this.executionLocks.get(id);
// Create lock
let release: () => void;
this.executionLocks.set(id, new Promise(r => release = r));
// ... execute ... finally: this.executionLocks.delete(id); release!();
```

---

## 🟡 Suggestions — Improvements to consider

| # | Location | Issue |
|---|----------|-------|
| 1 | `index.ts:123-209` | Executable path validation at kernel start (not just `kernels:validate`) |
| 2 | `app/index.tsx:46, 442` | `logs` array grows unbounded — cap at ~500 entries |
| 3 | `kernel-manager.ts:341-352` | ZMQ socket connect errors not caught — kernel hangs in "starting" state forever |
| 4 | `kernel-manager.ts:318`, `index.ts:218` | Config objects (with paths) logged in full — risk if users share logs for debugging |
| 5 | `kernel-manager.ts:335, 590` | Magic timeout numbers (`10000`, `30000`) — extract to named constants |
| 6 | `file-scanner.ts:46-79` | Symlinks silently ignored — document or handle |
| 7 | `app/index.tsx:494` | Auto-refresh namespace calls can pile up if prior request is still in-flight — skip if `isRefreshing` |

---

## ✅ Good Practices — What's done well

### 1. Textbook Electron Security Config
**`electron/main/app.ts:18-19`**
```typescript
contextIsolation: true,
nodeIntegration: false,
```
Prevents renderer-side XSS from accessing Node APIs. Many Electron apps get this wrong.

### 2. Typed IPC Bridge
**`electron/main/ipc.ts` + `electron/preload.ts`**  
Single source of truth for channel names and typed contracts. Compile-time safety across the IPC boundary.

### 3. `shell: false` in `spawn`
**`electron/main/index.ts:1014-1018`**  
Correctly prevents shell metacharacter injection. Like keeping vision on your jungle in League of Legends — you're already covered on the obvious flank.

### 4. Comprehensive `sanitizeScriptName`
**`electron/main/index.ts:983-992`**  
Blocks directory traversal, special characters, length abuse, and whitespace — all in one tightly scoped function.

### 5. Graceful Kernel Shutdown Sequence
**`electron/main/kernel-manager.ts:421-485`**  
SIGTERM → delay → SIGKILL pattern with socket cleanup. Handles real-world kernel crashes gracefully.

### 6. Path Traversal Protection in Python Init
**`electron/main/init/python-init.py:37-52`**  
`_resolve_project_path` uses `os.path.commonpath` to prevent escaping the project root from within kernel code.

### 7. Debounced Command-Box Saves
**`electron/renderer/src/app/index.tsx:86-118`**  
500ms debounce on persistence writes. Prevents excessive file I/O during rapid typing/switching.

### 8. Well-Documented Init Scripts
**`electron/main/init/python-init.py`**  
Clear docstrings explain PDV's custom kernel environment, making onboarding and debugging straightforward.

---

## 📊 Summary

| Category | Count |
|----------|-------|
| 🔴 Critical Issues | 5 |
| 🟡 Suggestions | 7 |
| ✅ Good Practices | 8 |

**Overall:** Solid architecture with correct Electron security fundamentals. The critical issues are all fixable validation/boundary-checking gaps rather than fundamental design flaws. Prioritise Issues #1–3 before any public or multi-user deployment.

### Priority Order

**Before merge:**
1. Add HMAC signature validation in `parseMessage` (Issue #1)
2. Add `safeJsonParse` with size limit (Issue #2)
3. Validate file paths against `treeRoot` in `files:read` / `files:write` (Issue #3)

**Post-merge:**
4. Fix race condition with per-kernel execution mutex (Issue #5)
5. Validate editor file path in `openInEditor` (Issue #4)
6. Cap `logs` array length (Suggestion #2)
7. Add integration tests for IPC handlers and concurrent kernel execution
