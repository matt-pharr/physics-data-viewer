/**
 * julia-makie-save.spec.ts — GUI save flow with a live Makie figure in the tree.
 *
 * Regression spec for the reported "save doesn't work" bug: a Julia project
 * holding CairoMakie figures hung the save (the checksum's structural walk
 * never terminated on the figure's cyclic observable graph). This drives the
 * REAL Save As dialog — menu action → name field → native directory picker
 * (stubbed) → Save — rather than the synthesized explicit-path save the other
 * specs use, then a plain Cmd+S resave, then a load round trip.
 *
 * Requires JULIA_PATH plus CairoMakie installed in the Julia environment.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";

const juliaPath = process.env.JULIA_PATH ??
  (process.env.PDV_E2E_JULIA === "1" ? "julia" : undefined);

test.skip(!juliaPath, "JULIA_PATH not set — Julia Makie-save e2e skipped");

// Sequential stages over one app instance: a failure skips the rest instead
// of restarting the worker (which would re-run beforeAll into a fresh dir).
test.describe.configure({ mode: "serial" });

const PROJECT_NAME = "Lorenz Save Test";

let launched: LaunchedApp;
let parentDir: string;
const saveDir = () => path.join(parentDir, PROJECT_NAME);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-makie-save-"));
  launched = await launchPDV({
    preferences: { juliaPath },
    env: {
      JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH ??
        `${path.join(os.homedir(), ".julia")}:`,
    },
  });
  await launched.window.getByRole("button", { name: "New Julia Project" }).click();
  await expectKernelReady(launched.window, 240_000);
});

test.afterAll(async () => {
  await launched?.cleanup();
  if (parentDir) await fs.rm(parentDir, { recursive: true, force: true });
});

async function runInCodeCell(code: string): Promise<void> {
  const { window } = launched;
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
}

test("build a tree with a live CairoMakie figure", async () => {
  test.setTimeout(300_000);
  // Single cell: import (first-use JIT can be slow), figure, plain data.
  await runInCodeCell(
    [
      "using CairoMakie",
      "fig = Figure()",
      "ax = Axis(fig[1, 1])",
      "lines!(ax, 1:100, sin.(0.1 .* (1:100)))",
      'pdv_tree["lorenz"] = Dict{String,Any}()',
      'pdv_tree["lorenz.attractor_fig"] = fig',
      'pdv_tree["lorenz.trajectory"] = (t=collect(1.0:100.0), x=rand(100))',
      // A numeric-array leaf makes "lorenz" a composite container (per-leaf
      // descriptors) instead of one whole-dict .jls blob — matching the
      // reported failing project, which held a DataFrame alongside figures.
      'pdv_tree["lorenz.samples"] = rand(200)',
      'println("tree seeded")',
    ].join("\n"),
  );
  await expect(launched.window.locator(".log-stdout", { hasText: "tree seeded" }))
    .toBeVisible({ timeout: 240_000 });
  // Children render only once the parent folder is expanded.
  const expandLorenz = launched.window.getByRole("button", { name: "Expand lorenz" });
  await expect(expandLorenz).toBeVisible({ timeout: 30_000 });
  await expandLorenz.click();
  await expect(launched.window.locator(".tree-row", { hasText: "attractor_fig" }))
    .toBeVisible({ timeout: 30_000 });
});

test("Save As dialog flow writes the project to <location>/<name>/", async () => {
  test.setTimeout(240_000);
  const { window, app } = launched;

  // Stub the native directory picker the dialog's "Choose..." button opens.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () =>
      ({ canceled: false, filePaths: [dir] }) as Awaited<
        ReturnType<typeof dialog.showOpenDialog>
      >;
  }, parentDir);

  await sendMenuAction(app, { action: "project:saveAs" });

  await expect(window.getByRole("heading", { name: "Save Project As" })).toBeVisible();
  await window.getByLabel("Project name").fill(PROJECT_NAME);
  // The location row's <label> wraps the button, so its accessible name is
  // the label text, not "Choose..." — target it by class instead.
  await window.locator(".save-as-location-row button").click();
  await expect(window.locator(".save-as-location-path")).toHaveText(parentDir);
  await window.getByRole("button", { name: "Save", exact: true }).click();

  // project.json is the save commit gate — written last (ARCHITECTURE §8.1).
  await expect
    .poll(
      async () => {
        try {
          await fs.stat(path.join(saveDir(), "project.json"));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  const manifest = JSON.parse(
    await fs.readFile(path.join(saveDir(), "project.json"), "utf8"),
  ) as { language?: string; name?: string };
  expect(manifest.language).toBe("julia");

  const index = JSON.parse(
    await fs.readFile(path.join(saveDir(), "tree-index.json"), "utf8"),
  ) as Array<{ path: string; storage?: { format?: string } }>;
  const figEntry = index.find((e) => e.path === "lorenz.attractor_fig");
  expect(figEntry?.storage?.format).toBe("jls");
  expect(index.find((e) => e.path === "lorenz.samples")?.storage?.format).toBe("npy");
  expect(index.find((e) => e.path === "lorenz.trajectory")).toBeTruthy();
});

test("plain resave (Cmd+S path) succeeds into the same directory", async () => {
  test.setTimeout(120_000);
  const before = (await fs.stat(path.join(saveDir(), "project.json"))).mtimeMs;

  await runInCodeCell('pdv_tree["lorenz.note"] = "resave probe"; println("note added")');
  await expect(launched.window.locator(".log-stdout", { hasText: "note added" }))
    .toBeVisible({ timeout: 60_000 });

  // With a project dir set, project:save without a path resaves in place.
  await sendMenuAction(launched.app, { action: "project:save" });

  await expect
    .poll(
      async () => (await fs.stat(path.join(saveDir(), "project.json"))).mtimeMs,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(before);

  const index = JSON.parse(
    await fs.readFile(path.join(saveDir(), "tree-index.json"), "utf8"),
  ) as Array<{ path: string }>;
  expect(index.find((e) => e.path === "lorenz.note")).toBeTruthy();
});

test("saved figure loads back and is a live Figure in the kernel", async () => {
  test.setTimeout(240_000);
  const { window } = launched;

  await window.evaluate(async (dir) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).pdv.project.load(dir);
  }, saveDir());

  await expect(window.locator(".tree-row", { hasText: "lorenz" }))
    .toBeVisible({ timeout: 60_000 });

  await runInCodeCell('println(typeof(pdv_tree["lorenz.attractor_fig"]))');
  await expect(window.locator(".log-stdout", { hasText: "Figure" }).first())
    .toBeVisible({ timeout: 60_000 });
});
