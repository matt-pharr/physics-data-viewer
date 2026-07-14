/**
 * julia-smoke.spec.ts — Julia-kernel end-to-end smoke test.
 *
 * Drives the full Julia session path through the real app: welcome screen →
 * "New Julia Project" → IJulia + PDVKernel boot → code-cell execution →
 * tree.changed push → tree panel refresh → script create + run.
 *
 * Requires a Julia environment with IJulia and PDVKernel (dev-installed from
 * pdv-julia/). Skipped unless JULIA_PATH is set (or `julia` is on PATH and
 * PDV_E2E_JULIA=1).
 */

import { test, expect } from "@playwright/test";
import * as os from "os";
import * as path from "path";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";

const juliaPath = process.env.JULIA_PATH ??
  (process.env.PDV_E2E_JULIA === "1" ? "julia" : undefined);

test.skip(!juliaPath, "JULIA_PATH not set — Julia e2e smoke skipped");

let launched: LaunchedApp;

test.beforeAll(async () => {
  // Julia first-boot JIT + kernel handshake can take a while on a cold cache.
  test.setTimeout(300_000);
  launched = await launchPDV({
    preferences: { juliaPath },
    env: {
      // launchPDV swaps HOME for a temp dir; Julia's package depot lives
      // under the real home, so pin it explicitly or the spawned kernel
      // can't find IJulia/PDVKernel. The trailing colon appends the default
      // bundled depots (stdlib precompile caches) after the user depot.
      JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH ??
        `${path.join(os.homedir(), ".julia")}:`,
    },
  });
  await launched.window.getByRole("button", { name: "New Julia Project" }).click();
  await expectKernelReady(launched.window, 240_000);
});

test.afterAll(async () => {
  await launched?.cleanup();
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

test("println output reaches the console", async () => {
  await runInCodeCell('println("hello from julia")');
  await expect(launched.window.locator(".log-stdout").first())
    .toContainText("hello from julia", { timeout: 30_000 });
});

test("pdv_tree assignment pushes a tree panel update", async () => {
  await runInCodeCell('pdv_tree["waveform"] = collect(range(0.0, 1.0, length=32))');
  // The tree.changed push (or the 1 Hz poll) should surface the new node.
  await expect(launched.window.locator(".tree-row", { hasText: "waveform" }))
    .toBeVisible({ timeout: 30_000 });
});

test("create a Julia script from the tree and run it", async () => {
  const { window } = launched;

  const root = window.locator(".tree-row", { hasText: "pdv_tree" });
  await expect(root).toBeVisible();
  await root.click({ button: "right" });

  await window.getByRole("menuitem", { name: "Create new script" })
    .or(window.locator(".context-menu-item", { hasText: "Create new script" }))
    .first()
    .click();

  await expect(window.getByRole("heading", { name: "Create new script" })).toBeVisible();
  await window.getByRole("textbox", { name: "Script name" }).fill("julia_demo");
  await window.getByRole("button", { name: "Create", exact: true }).click();

  // The stub is created with the Julia template; the node appears after the
  // register comm round-trips.
  await expect(window.locator(".tree-row", { hasText: "julia_demo" }))
    .toBeVisible({ timeout: 30_000 });

  // Run it through the kernel with the exact invocation script:run builds.
  await runInCodeCell('PDVKernel.run_tree_script(pdv_tree, "julia_demo")');
  await expect(window.locator(".log-result").last())
    .toContainText("Dict", { timeout: 30_000 });
});
