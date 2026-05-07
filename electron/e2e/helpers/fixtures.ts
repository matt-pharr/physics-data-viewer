/**
 * fixtures.ts — Build on-disk PDV save directories for E2E tests.
 *
 * Schemas mirror what the kernel and main process write at save time:
 * - tree-index.json: array of {path, type, storage, metadata} per node
 * - project.json: ProjectManifest (project-manager.ts)
 * - code-cells.json: CodeCellData (ipc.ts)
 *
 * Reuse `<saveDir>/.autosave/...` for autosave fixtures.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const SCHEMA_VERSION = "1.1";

/** Lazy-read pdv version from electron/package.json so fixtures stay in sync. */
async function getAppVersion(): Promise<string> {
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  const raw = await fs.readFile(pkgPath, "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

interface TreeIndexEntry {
  path: string;
  type: string;
  storage: { backend: string; format: string; value?: unknown };
  metadata: { preview: string };
}

async function writeProjectMetadata(
  saveDir: string,
  opts: { projectName?: string; language?: "python" | "julia" } = {},
): Promise<void> {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    pdv_version: await getAppVersion(),
    tree_checksum: "",
    language: opts.language ?? "python",
    project_name: opts.projectName ?? path.basename(saveDir),
    modules: [],
    module_settings: {},
  };
  await fs.writeFile(
    path.join(saveDir, "project.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

async function writeTreeIndex(saveDir: string, entries: TreeIndexEntry[]): Promise<void> {
  await fs.writeFile(
    path.join(saveDir, "tree-index.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
}

async function writeCodeCells(
  saveDir: string,
  cells: { id: number; code: string; name?: string }[] = [{ id: 1, code: "" }],
  activeTabId = 1,
): Promise<void> {
  await fs.writeFile(
    path.join(saveDir, "code-cells.json"),
    JSON.stringify({ tabs: cells, activeTabId }, null, 2),
    "utf8",
  );
}

/**
 * Create an empty PDV project in the given (already-existing) directory.
 *
 * Writes project.json, tree-index.json (empty), and code-cells.json (one
 * blank tab).
 */
export async function makeEmptyProject(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeProjectMetadata(dir);
  await writeTreeIndex(dir, []);
  await writeCodeCells(dir);
}

/**
 * Create a project pre-populated with inline scalar values at top-level paths.
 *
 * Each entry in `scalars` becomes a `scalar` node with `storage.backend = "inline"`,
 * matching the kernel's serialization for primitive ints/floats/strings/bools.
 */
export async function makeProjectWithScalars(
  dir: string,
  scalars: Record<string, number | string | boolean>,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeProjectMetadata(dir);

  const entries: TreeIndexEntry[] = Object.entries(scalars).map(([k, v]) => ({
    path: k,
    type: "scalar",
    storage: { backend: "inline", format: "inline", value: v },
    metadata: { preview: String(v) },
  }));
  await writeTreeIndex(dir, entries);
  await writeCodeCells(dir);
}

/**
 * Seed an orphan working directory under `os.tmpdir()` that the welcome
 * screen's "Recoverable Sessions" surface should pick up.
 *
 * Returns the absolute path to the created `pdv-<sessionId>` directory so the
 * caller can clean up afterwards. The session.lock contains a PID that is
 * extremely unlikely to be alive (PID 1 is init/launchd; we use a high
 * synthetic value that shouldn't exist).
 */
export async function makeAutosaveOrphan(
  workingBase: string,
  scalars: Record<string, number | string | boolean> = { recovered: 1 },
): Promise<string> {
  await fs.mkdir(workingBase, { recursive: true });
  const sessionId = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sessionDir = path.join(workingBase, `pdv-${sessionId}`);
  const autosaveDir = path.join(sessionDir, ".autosave");
  await fs.mkdir(autosaveDir, { recursive: true });

  await fs.writeFile(
    path.join(sessionDir, "session.lock"),
    JSON.stringify({ pid: 999_999_999, sessionId }, null, 2),
    "utf8",
  );

  await writeProjectMetadata(autosaveDir);
  const entries: TreeIndexEntry[] = Object.entries(scalars).map(([k, v]) => ({
    path: k,
    type: "scalar",
    storage: { backend: "inline", format: "inline", value: v },
    metadata: { preview: String(v) },
  }));
  await writeTreeIndex(autosaveDir, entries);
  await writeCodeCells(autosaveDir);
  return sessionDir;
}

/** Convenience: mkdtemp under the OS temp root with a recognizable prefix. */
export async function mkE2eTmpDir(label = "save"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `pdv-e2e-${label}-`));
}
