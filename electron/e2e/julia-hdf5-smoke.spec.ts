/**
 * julia-hdf5-smoke.spec.ts — Julia PDVHdf5 end-to-end smoke.
 *
 * Drives the Julia half of the lazy HDF5 tree nodes through the real app
 * (real IJulia kernel, pkg-mode project whose Initial-packages prefill
 * installs CairoMakie + HDF5). Three things only e2e can vouch for:
 *
 *   1. Cross-language parity — the fixture is written by *h5py* (the exact
 *      generator dataset-nodes.spec.ts uses for the Python half), so this
 *      spec asserts a Python-authored file browses in a Julia session with
 *      the same keys, chips, and previews. One deliberate divergence:
 *      multi-dimensional dataset previews show each language's true array
 *      shape — h5py reads the (2, 3) C-order dataset as 2 × 3, HDF5.jl
 *      reads it column-major as 3 × 2. Same bytes, honest per-language
 *      representation.
 *   2. Busy-compute expansion — expanding HDF5 groups while a non-yielding
 *      computation runs, i.e. served from the threaded query server's
 *      snapshot (query_cache.jl memo), not the comm channel.
 *   3. Double-click plot through the full new stack — CairoMakie
 *      auto-load on first plot, the figure routed into a tracked console
 *      entry with a real (non-zero) duration.
 *
 * Requires JULIA_PATH (IJulia + dev-installed PDVKernel) and PYTHON_PATH
 * (h5py, for the fixture); skipped otherwise.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";

const juliaPath = process.env.JULIA_PATH ??
  (process.env.PDV_E2E_JULIA === "1" ? "julia" : undefined);
const pythonPath = process.env.PYTHON_PATH;

test.skip(!juliaPath, "JULIA_PATH not set — Julia HDF5 e2e smoke skipped");
test.skip(!pythonPath, "PYTHON_PATH not set — h5py fixture generator unavailable");

// Same HDF5 layout as dataset-nodes.spec.ts (the Python half of this parity
// check): a scalar, a group with a 2-D dataset, and a nested group.
const PY_FIXTURE_SRC = `
import os, sys, numpy as np, h5py
d = sys.argv[1]
os.makedirs(d, exist_ok=True)
with h5py.File(os.path.join(d, "efit.h5"), "w") as f:
    f.create_dataset("t0", data=np.float64(1.5))
    g = f.create_group("profiles")
    g.create_dataset("pressure", data=np.zeros((2, 3)))
    sub = g.create_group("fits")
    sub.create_dataset("psi", data=np.arange(4.0))
print("ok")
`;

let launched: LaunchedApp;
let fixtureDir: string;
let h5Path: string;

test.setTimeout(300_000);

/** The `.tree-row` whose key column text is exactly `key`. */
function rowByKey(window: Page, key: string): Locator {
  return window.locator(".tree-row", {
    has: window.locator(".tree-key-text", { hasText: new RegExp(`^${key}$`) }),
  });
}

/** Ensure the row named `key` is expanded (idempotent). */
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

/** Collapse the row named `key` if it is currently expanded. */
async function collapseRow(window: Page, key: string): Promise<void> {
  const btn = window.getByRole("button", { name: `Collapse ${key}`, exact: true });
  if (await btn.count()) await btn.first().click();
}

/** Type `code` into the command editor and click Execute (no completion wait). */
async function startCode(window: Page, code: string): Promise<void> {
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
}

/** Run `code` and wait for its console entry to finish (duration chip). */
async function runCode(window: Page, code: string): Promise<void> {
  const before = await window.locator(".log-duration").count();
  await startCode(window, code);
  await expect
    .poll(async () => window.locator(".log-duration").count(), { timeout: 60_000 })
    .toBeGreaterThan(before);
}

test.beforeAll(async () => {
  fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-jl-h5-"));
  execFileSync(pythonPath!, ["-c", PY_FIXTURE_SRC, fixtureDir], { stdio: "pipe" });
  h5Path = path.join(fixtureDir, "efit.h5");

  launched = await launchPDV({
    preferences: { juliaPath },
    env: {
      // launchPDV swaps HOME for a temp dir; the Julia depot lives under the
      // real home (see julia-smoke.spec.ts).
      JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH ??
        `${path.join(os.homedir(), ".julia")}:`,
    },
  });
  await launched.window.getByRole("button", { name: "New Julia Project" }).click();
  // Accept the dialog defaults — including the CairoMakie + HDF5 prefill,
  // which is exactly the path a fresh user hits.
  await launched.window.getByTestId("new-julia-project-create").click();
  await expectKernelReady(launched.window, 240_000);
});

test.afterAll(async () => {
  await launched?.cleanup();
  if (fixtureDir) await fsp.rm(fixtureDir, { recursive: true, force: true });
});

test("1. add_hdf5 on an h5py-written file → hdf5 chip + items preview", async () => {
  const { window } = launched;
  await runCode(
    window,
    `pdv_tree["efit"] = PDVKernel.add_hdf5(${JSON.stringify(h5Path)})`,
  );

  const row = rowByKey(window, "efit");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator(".tree-type-badge").first()).toHaveText("hdf5");
  await expect(row.locator(".tree-col.preview")).toHaveText("efit.h5 — 2 items");
  await expect(window.getByRole("button", { name: "Expand efit", exact: true })).toBeVisible();
});

test("2. groups + datasets expand with Python-matching chips and previews", async () => {
  const { window } = launched;
  await expandRow(window, "efit");

  // Root members: scalar dataset + group (keys and chips match the Python
  // half in dataset-nodes.spec.ts).
  await expect(rowByKey(window, "t0")).toBeVisible({ timeout: 15_000 });
  await expect(rowByKey(window, "t0").locator(".tree-type-badge", { hasText: "h5.Dataset" })).toBeVisible();
  await expect(rowByKey(window, "t0").locator(".tree-col.preview")).toHaveText("float64");
  await expect(rowByKey(window, "profiles")).toBeVisible();
  await expect(rowByKey(window, "profiles").locator(".tree-type-badge", { hasText: "group" })).toBeVisible();
  await expect(rowByKey(window, "profiles").locator(".tree-col.preview")).toHaveText("group (2 items)");

  await expandRow(window, "profiles");
  // Column-major shape: the same (2, 3) C-order dataset Python previews as
  // "float64 (2 × 3)" — see the file header comment.
  await expect(rowByKey(window, "pressure")).toBeVisible({ timeout: 15_000 });
  await expect(rowByKey(window, "pressure").locator(".tree-col.preview")).toHaveText("float64 (3 × 2)");
  await expect(rowByKey(window, "fits")).toBeVisible();
  await expect(rowByKey(window, "fits").locator(".tree-type-badge", { hasText: "group" })).toBeVisible();

  await expandRow(window, "fits");
  await expect(rowByKey(window, "psi")).toBeVisible({ timeout: 15_000 });
  await expect(rowByKey(window, "psi").locator(".tree-col.preview")).toHaveText("float64 (4)");

  // Dot-path descent agrees with what the tree shows.
  await runCode(window, 'println(size(read(pdv_tree["efit.profiles.pressure"])))');
  await expect(launched.window.locator(".log-stdout").last()).toContainText("(3, 2)", {
    timeout: 20_000,
  });
});

test("3. HDF5 groups expand mid-computation via the query-server snapshot", async () => {
  const { window } = launched;
  // Collapse everything so the re-expansion below issues fresh tree.list
  // requests while the kernel is busy.
  await collapseRow(window, "efit");

  // Non-yielding busy loop (time() never yields to the scheduler): the
  // comm channel is dead until it finishes, so any listing that renders
  // during it was served by the threaded query server from the snapshot.
  const durationsBefore = await window.locator(".log-duration").count();
  await startCode(window, "t0_busy = time(); while time() - t0_busy < 12.0; end; println(\"busy done\")");

  // Give the kernel a beat to enter the loop, then browse the h5 subtree.
  await window.waitForTimeout(1_500);
  await expandRow(window, "efit");
  await expect(rowByKey(window, "profiles")).toBeVisible({ timeout: 8_000 });
  await expandRow(window, "profiles");
  await expect(rowByKey(window, "fits")).toBeVisible({ timeout: 8_000 });
  await expandRow(window, "fits");
  await expect(rowByKey(window, "psi")).toBeVisible({ timeout: 8_000 });

  // The busy cell itself completes afterwards (sanity: kernel was really
  // occupied the whole time, and comes back healthy).
  await expect(window.locator(".log-stdout", { hasText: "busy done" })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => window.locator(".log-duration").count())
    .toBeGreaterThan(durationsBefore);
});

test("4. double-click plots via CairoMakie auto-load with a real duration", async () => {
  // Cold path: the auto-require may precompile CairoMakie in the fresh
  // project env — minutes, not seconds. The invoke timeout is 300 s.
  test.setTimeout(420_000);
  const { window } = launched;
  const imagesBefore = await window.locator(".log-image").count();

  await rowByKey(window, "psi").dblclick();

  // The tracked console entry appears immediately (Execution: Handler <path>).
  const entry = window.locator(".log-entry", { hasText: "Handler efit.profiles.fits.psi" });
  await expect(entry).toBeVisible({ timeout: 15_000 });

  // First plot pays the CairoMakie auto-require + time-to-first-plot; the
  // figure must land INSIDE the tracked entry, and the measured duration
  // must reflect that cost rather than the old hardcoded 0 ms.
  await expect
    .poll(async () => window.locator(".log-image").count(), { timeout: 300_000 })
    .toBeGreaterThan(imagesBefore);
  await expect(entry.locator(".log-image").first()).toBeVisible();

  const durationText = await entry.locator(".log-duration").innerText({ timeout: 30_000 });
  const ms = Number.parseInt(durationText.replace(/\D+/g, ""), 10);
  expect(ms).toBeGreaterThan(100);
});
