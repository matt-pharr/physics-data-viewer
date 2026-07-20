/**
 * dataset-nodes.spec.ts — NEW spec (QA pass for branch feature/dataset-nodes).
 *
 * End-to-end coverage for the two lazy tree node types added in
 * feature/dataset-nodes, driven through the real Electron bundle + a real
 * Python kernel (with xarray/netCDF4/h5py installed in PYTHON_PATH):
 *
 *   PDVDataset (kind `dataset_file`, chip `netcdf`)  — NetCDF via xarray
 *   PDVHdf5    (kind `hdf5_file`,   chip `hdf5`)     — HDF5 via h5py
 *
 * Verifies (numbered to the QA brief):
 *   1. add_file(.nc) + assign → node with chip `netcdf`, counts preview, chevron.
 *   2. Expand netcdf: data_vars THEN coords; children chip `xr.DataArray`;
 *      coord rows carry a `coord` chip + `.coord` class on `.tree-row`.
 *   3. add_file(.h5) → chip `hdf5`, `N items` preview; groups (chip `group`)
 *      expand recursively; datasets chip `h5.Dataset`, `float64 (r × c)`.
 *   4. Dot-path + slash-path console access agree.
 *   5. (best-effort) Double-clicking a 1-D var must not raise a [PDV] error.
 *   6. Save → reload → nodes come back with same chips and still expand;
 *      backing files live at <save_dir>/tree/<uuid>/<filename>.
 *   7. (best-effort) Virtual children have no rename/move/duplicate/delete;
 *      the file node itself keeps them.
 *   8. (best-effort) tree-index.json holds only the file nodes (format
 *      netcdf/hdf5, preview-only metadata), never the virtual children.
 *
 * Fixtures are generated at runtime by shelling out to PYTHON_PATH so the
 * spec is self-contained.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";

let launched: LaunchedApp;
let fixtureDir: string;
let ncPath: string;
let h5Path: string;
// Save dir created by the save test; the restart test's file-backed restore
// reads from it, so it must outlive both — cleaned in afterAll.
let saveDir: string | undefined;

// Collected renderer console messages so item 5 can assert no [PDV] error
// fires on double-click. Populated from beforeAll onward.
const consoleErrors: string[] = [];

const PY_FIXTURE_SRC = `
import os, sys, numpy as np, xarray as xr, h5py
d = sys.argv[1]
os.makedirs(d, exist_ok=True)
ds = xr.Dataset(
    {"phi": (("x",), np.array([1.0, 2.0, 3.0])),
     "psi": (("x", "y"), np.zeros((3, 2)))},
    coords={"x": [0, 1, 2], "y": [0.5, 1.5]},
)
ds.to_netcdf(os.path.join(d, "gpec.nc")); ds.close()
with h5py.File(os.path.join(d, "efit.h5"), "w") as f:
    f.create_dataset("t0", data=np.float64(1.5))
    f.attrs["shot"] = 12345
    g = f.create_group("profiles")
    g.create_dataset("pressure", data=np.zeros((2, 3)))
    sub = g.create_group("fits")
    sub.create_dataset("psi", data=np.arange(4.0))
print("ok")
`;

test.setTimeout(180_000);

// ── helpers ──────────────────────────────────────────────────────────────

/** Type `code` into the command editor and run it; wait for the round-trip. */
async function runCode(window: Page, code: string): Promise<void> {
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
  await expect(window.locator(".log-duration").last()).toBeVisible({ timeout: 20_000 });
}

/** The `.tree-row` whose key column text is exactly `key`. */
function rowByKey(window: Page, key: string): Locator {
  return window.locator(".tree-row", {
    has: window.locator(".tree-key-text", { hasText: new RegExp(`^${key}$`) }),
  });
}

/**
 * Ensure the row named `key` is expanded. Idempotent: clicks the Expand
 * chevron if present, otherwise asserts the row is already expanded (the
 * session-restore path restores expansion state, so a node can come back
 * already open).
 */
async function expandRow(window: Page, key: string): Promise<void> {
  const expandBtn = window.getByRole("button", { name: `Expand ${key}`, exact: true });
  if (await expandBtn.count()) {
    await expandBtn.first().click();
    return;
  }
  await expect(
    window.getByRole("button", { name: `Collapse ${key}`, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Collapse the row named `key` if it is currently expanded (no-op otherwise). */
async function collapseRow(window: Page, key: string): Promise<void> {
  const btn = window.getByRole("button", { name: `Collapse ${key}`, exact: true });
  if (await btn.count()) await btn.first().click();
}

/** Ordered list of every visible tree-row key. */
async function visibleKeys(window: Page): Promise<string[]> {
  return window.locator(".tree-row .tree-key-text").allInnerTexts();
}

// ── setup / teardown ─────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Fresh uv venv + netcdf4/h5py install + kernel boot can run long.
  test.setTimeout(300_000);
  const py = process.env.PYTHON_PATH;
  if (!py) throw new Error("PYTHON_PATH must be set for dataset-nodes.spec");

  fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-dataset-fix-"));
  execFileSync(py, ["-c", PY_FIXTURE_SRC, fixtureDir], { stdio: "pipe" });
  ncPath = path.join(fixtureDir, "gpec.nc");
  h5Path = path.join(fixtureDir, "efit.h5");

  launched = await launchPDV();
  const window = launched.window;
  window.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[PDV]") && (msg.type() === "error" || /error/i.test(text))) {
      consoleErrors.push(text);
    }
  });

  // The default uv flow builds a self-contained venv that only has
  // pdv + numpy + matplotlib. PDVDataset/PDVHdf5 need the optional
  // scientific deps, so seed them into the "Initial packages" field
  // before creating the project.
  await window.getByRole("button", { name: "New Python Project" }).click();
  const pkgs = window.getByTestId("new-project-packages");
  await expect(pkgs).toBeVisible();
  await pkgs.fill("numpy, matplotlib, xarray, netcdf4, h5py");
  await window.getByTestId("new-project-create").click();
  await expectKernelReady(window, 240_000);
});

test.afterAll(async () => {
  await launched?.cleanup();
  if (fixtureDir) await fsp.rm(fixtureDir, { recursive: true, force: true });
  if (saveDir) await fsp.rm(saveDir, { recursive: true, force: true });
});

// ── 1. netcdf node create ────────────────────────────────────────────────

test("1. add_file(.nc) creates a netcdf node with counts preview + chevron", async () => {
  const { window } = launched;
  await runCode(window, `import pdv; pdv_tree["ncds"] = pdv.add_file(${JSON.stringify(ncPath)})`);

  const row = rowByKey(window, "ncds");
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator(".tree-type-badge").first()).toHaveText("netcdf");
  await expect(row.locator(".tree-col.preview")).toHaveText("gpec.nc — 2 vars, 2 coords");
  // Expand chevron present (hasChildren → toggle not .hidden).
  await expect(window.getByRole("button", { name: "Expand ncds", exact: true })).toBeVisible();
});

// ── 2. netcdf expansion: vars then coords ────────────────────────────────

test("2. expanding netcdf lists data_vars then coords with coord chips", async () => {
  const { window } = launched;
  await expandRow(window, "ncds");

  await expect(rowByKey(window, "phi")).toBeVisible({ timeout: 15_000 });
  await expect(rowByKey(window, "psi")).toBeVisible();
  await expect(rowByKey(window, "x")).toBeVisible();
  await expect(rowByKey(window, "y")).toBeVisible();

  // Ordering: data_vars (phi, psi) before coords (x, y).
  const keys = await visibleKeys(window);
  const idx = (k: string) => keys.indexOf(k);
  expect(idx("phi")).toBeGreaterThanOrEqual(0);
  expect(idx("phi")).toBeLessThan(idx("x"));
  expect(idx("psi")).toBeLessThan(idx("x"));
  expect(idx("psi")).toBeLessThan(idx("y"));

  // All four children carry the xr.DataArray chip.
  for (const k of ["phi", "psi", "x", "y"]) {
    await expect(
      rowByKey(window, k).locator(".tree-type-badge", { hasText: "xr.DataArray" }),
    ).toBeVisible();
  }

  // data_vars are NOT coords; coords are.
  await expect(rowByKey(window, "phi")).not.toHaveClass(/(^|\s)coord(\s|$)/);
  await expect(rowByKey(window, "x")).toHaveClass(/(^|\s)coord(\s|$)/);
  await expect(rowByKey(window, "y")).toHaveClass(/(^|\s)coord(\s|$)/);
  await expect(rowByKey(window, "x").locator(".tree-type-badge", { hasText: "coord" })).toBeVisible();

  // Collapse so the netcdf `psi` var doesn't collide with the hdf5 `psi`
  // dataset in later tests (the tree is a flat, virtualized DOM list).
  await collapseRow(window, "ncds");
});

// ── 3. hdf5 node create + recursive group expansion ──────────────────────

test("3. add_file(.h5) creates an hdf5 node; groups expand recursively", async () => {
  const { window } = launched;
  await collapseRow(window, "ncds"); // guard: no colliding netcdf `psi` visible
  await runCode(window, `pdv_tree["efit.data"] = pdv.add_file(${JSON.stringify(h5Path)})`);

  // efit (folder) appears; expand to reveal the hdf5 file node `data`.
  await expect(rowByKey(window, "efit")).toBeVisible({ timeout: 20_000 });
  await expandRow(window, "efit");

  const dataRow = rowByKey(window, "data");
  await expect(dataRow).toBeVisible({ timeout: 15_000 });
  await expect(dataRow.locator(".tree-type-badge").first()).toHaveText("hdf5");
  await expect(dataRow.locator(".tree-col.preview")).toHaveText("efit.h5 — 2 items");

  // Expand the hdf5 file node → group `profiles` + dataset `t0`.
  await expandRow(window, "data");
  const profRow = rowByKey(window, "profiles");
  await expect(profRow).toBeVisible({ timeout: 15_000 });
  await expect(profRow.locator(".tree-type-badge").first()).toHaveText("group");
  await expect(profRow.locator(".tree-col.preview")).toHaveText("group (2 items)");
  const t0Row = rowByKey(window, "t0");
  await expect(t0Row.locator(".tree-type-badge").first()).toHaveText("h5.Dataset");

  // Expand group → dataset `pressure` (2×3) + subgroup `fits`.
  await expandRow(window, "profiles");
  const pressRow = rowByKey(window, "pressure");
  await expect(pressRow).toBeVisible({ timeout: 15_000 });
  await expect(pressRow.locator(".tree-type-badge").first()).toHaveText("h5.Dataset");
  await expect(pressRow.locator(".tree-col.preview")).toHaveText("float64 (2 × 3)");
  const fitsRow = rowByKey(window, "fits");
  await expect(fitsRow.locator(".tree-type-badge").first()).toHaveText("group");

  // Group-inside-a-group: expand `fits` → dataset `psi` (4,).
  await expandRow(window, "fits");
  const psiRow = rowByKey(window, "psi");
  await expect(psiRow).toBeVisible({ timeout: 15_000 });
  await expect(psiRow.locator(".tree-type-badge").first()).toHaveText("h5.Dataset");
  await expect(psiRow.locator(".tree-col.preview")).toHaveText("float64 (4)");

  await collapseRow(window, "efit");
});

// ── 4. dot-path and slash-path console access ────────────────────────────

test("4. dot-path and slash-path access agree in the console", async () => {
  const { window } = launched;

  await runCode(window, `pdv_tree["efit.data.profiles.pressure"].shape`);
  await expect(window.locator(".log-result").last()).toHaveText("(2, 3)", { timeout: 15_000 });

  await runCode(window, `pdv_tree["efit.data"]["profiles/pressure"].shape`);
  await expect(window.locator(".log-result").last()).toHaveText("(2, 3)", { timeout: 15_000 });

  // netcdf dot-path too.
  await runCode(window, `pdv_tree["ncds.phi"].shape`);
  await expect(window.locator(".log-result").last()).toHaveText("(3,)", { timeout: 15_000 });
});

// ── 5. double-click a 1-D var (best-effort) ──────────────────────────────

test("5. double-clicking a 1-D var does not raise a [PDV] error", async () => {
  const { window } = launched;
  // Ensure the netcdf children are visible (ncds was collapsed after test 2).
  if (!(await rowByKey(window, "phi").isVisible())) {
    await expandRow(window, "ncds");
    await expect(rowByKey(window, "phi")).toBeVisible({ timeout: 15_000 });
  }
  const before = consoleErrors.length;
  await rowByKey(window, "phi").dblclick();
  // Give any async plot dispatch a beat to fail loudly if it will.
  await window.waitForTimeout(2500);
  const newErrors = consoleErrors.slice(before);
  expect(newErrors, `[PDV] console errors after dblclick:\n${newErrors.join("\n")}`).toEqual([]);
});

// ── 8. save → tree-index.json holds only the file nodes ──────────────────

test("8. saved tree-index.json holds only file nodes (no virtual children)", async () => {
  const { app } = launched;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-dataset-save-"));
  saveDir = dir; // module-scoped so the restart test + afterAll can reach it

  await sendMenuAction(app, { action: "project:save", path: dir });
  await expect
    .poll(async () => fs.existsSync(path.join(dir, "tree-index.json")), { timeout: 20_000 })
    .toBe(true);

  const entries = JSON.parse(
    await fsp.readFile(path.join(dir, "tree-index.json"), "utf8"),
  ) as Array<{ path: string; type: string; storage?: Record<string, unknown>; metadata?: Record<string, unknown> }>;
  const byPath = new Map(entries.map((e) => [e.path, e]));

  const nc = byPath.get("ncds");
  expect(nc, "ncds entry present").toBeTruthy();
  expect(nc!.type).toBe("dataset_file");
  expect(nc!.storage?.format).toBe("netcdf");
  expect(Object.keys(nc!.metadata ?? {})).toEqual(["preview"]);

  const h5 = byPath.get("efit.data");
  expect(h5, "efit.data entry present").toBeTruthy();
  expect(h5!.type).toBe("hdf5_file");
  expect(h5!.storage?.format).toBe("hdf5");
  expect(Object.keys(h5!.metadata ?? {})).toEqual(["preview"]);

  // Virtual children must NOT be persisted as tree entries.
  const virtualPaths = [
    "ncds.phi", "ncds.psi", "ncds.x", "ncds.y",
    "efit.data.t0", "efit.data.profiles", "efit.data.profiles.pressure",
    "efit.data.profiles.fits", "efit.data.profiles.fits.psi",
  ];
  for (const p of virtualPaths) {
    expect(byPath.has(p), `virtual child ${p} must not be a tree entry`).toBe(false);
  }

  // Backing files live at <save_dir>/tree/<uuid>/<filename>.
  expect(
    fs.existsSync(path.join(dir, "tree", nc!.storage?.uuid as string, nc!.storage?.filename as string)),
  ).toBe(true);
  expect(
    fs.existsSync(path.join(dir, "tree", h5!.storage?.uuid as string, h5!.storage?.filename as string)),
  ).toBe(true);
  // NOTE: saveDir is intentionally NOT removed here — the restart test's
  // file-backed restore reads from it (project is now anchored to saveDir).
});

// ── 6. persistence across a session restart ──────────────────────────────

test("6. session restart reconstructs the dataset nodes; they still expand", async () => {
  const { window } = launched;

  // Restart the kernel: PDV snapshots the live tree, boots a fresh session,
  // and restores it — exercising the serialize → load_tree_index round-trip
  // of the new node types against the same working dir (files + deps intact).
  const status = window.locator('[data-testid="kernel-status"]');
  await window.locator('[data-testid="restart-session"]').click();
  await expect(status).toHaveAttribute("data-status", "starting", { timeout: 30_000 });
  await expectKernelReady(window, 60_000);

  // Both file nodes come back with their chips.
  const ncRow = rowByKey(window, "ncds");
  await expect(ncRow).toBeVisible({ timeout: 30_000 });
  await expect(ncRow.locator(".tree-type-badge").first()).toHaveText("netcdf");
  await expect(ncRow.locator(".tree-col.preview")).toHaveText("gpec.nc — 2 vars, 2 coords");

  await expect(rowByKey(window, "efit")).toBeVisible({ timeout: 15_000 });
  await expandRow(window, "efit");
  const dataRow = rowByKey(window, "data");
  await expect(dataRow.locator(".tree-type-badge").first()).toHaveText("hdf5");
  await collapseRow(window, "efit");

  // The reconstructed node still expands (reads the file header afresh).
  await expandRow(window, "ncds");
  await expect(rowByKey(window, "phi")).toBeVisible({ timeout: 15_000 });
  await expect(rowByKey(window, "x")).toHaveClass(/(^|\s)coord(\s|$)/);
  await collapseRow(window, "ncds");

  // hdf5 dot-path still resolves against the restored, live node.
  await runCode(window, `pdv_tree["efit.data.profiles.pressure"].shape`);
  await expect(window.locator(".log-result").last()).toHaveText("(2, 3)", { timeout: 15_000 });
});

// ── 7. context menu respects parent_is_opaque (best-effort) ──────────────

test("7. virtual children hide rename/move/duplicate/delete; file node keeps them", async () => {
  const { window } = launched;

  // Re-expand ncds after the reload in the previous test (tree state reset).
  if (!(await rowByKey(window, "phi").isVisible())) {
    await expandRow(window, "ncds");
    await expect(rowByKey(window, "phi")).toBeVisible({ timeout: 15_000 });
  }

  // Virtual child: no destructive/structural entries.
  await rowByKey(window, "phi").click({ button: "right" });
  await expect(window.locator(".context-menu-item").first()).toBeVisible({ timeout: 10_000 });
  for (const label of ["Rename", "Move to", "Duplicate to", "Delete"]) {
    await expect(window.locator(".context-menu-item", { hasText: label })).toHaveCount(0);
  }
  await window.keyboard.press("Escape");

  // The file node itself keeps rename + delete.
  await rowByKey(window, "ncds").click({ button: "right" });
  await expect(window.locator(".context-menu-item").first()).toBeVisible({ timeout: 10_000 });
  await expect(window.locator(".context-menu-item", { hasText: "Rename" })).toHaveCount(1);
  await expect(window.locator(".context-menu-item", { hasText: "Delete" })).toHaveCount(1);
  await window.keyboard.press("Escape");
});
