/**
 * autosave-recovery.spec.ts — Phase C3 spec.
 *
 * Two tests verify the orphan-autosave → Welcome-screen → Recover → tree-restore
 * round-trip:
 *
 * 1. Plain recovery — orphan dir contains only an autosave manifest + a
 *    single inline scalar. After Recover the value should appear in the
 *    tree and be readable from a code cell.
 *
 * 2. Recovery with a module — same as #1, but the orphan also has a
 *    `project.json` listing one in-session module and a matching
 *    `modules/<id>/` sidecar with the minimum manifest the recovery code
 *    looks for. We don't actually re-bind a real Python module here; the
 *    bar is "the modules/ dir is copied into the active workdir without
 *    error and the scalar still lands in the tree." Catches regressions
 *    in `recoverUnsaved`'s manifest+modules copy paths.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs/promises";
import * as path from "path";
import { launchPDV } from "./helpers/launch";
import { makeAutosaveOrphan } from "./helpers/fixtures";

test.setTimeout(120_000);

async function clickRecoverAndWaitForKernel(window: import("@playwright/test").Page): Promise<void> {
  // Welcome surfaces orphans under "Recoverable Unsaved Sessions"; the row's
  // primary action is the "Recover" button. Click it and wait for the kernel
  // status indicator to flip to Connected.
  await expect(window.getByRole("heading", { name: "Recoverable Unsaved Sessions" })).toBeVisible({ timeout: 15_000 });
  await window.getByRole("button", { name: "Recover" }).first().click();
  await expect(window.getByText(/●\s+Connected\b/)).toBeVisible({ timeout: 60_000 });
}

test("orphan with tree state only is restored on Recover", async () => {
  const launched = await launchPDV({
    onBeforeLaunch: async (homeDir) => {
      await makeAutosaveOrphan(path.join(homeDir, ".PDV", "working"), { recovered: 42 });
    },
  });
  try {
    await clickRecoverAndWaitForKernel(launched.window);

    // The tree should refresh after recover and show the inline scalar.
    await expect(
      launched.window.locator(".tree-row", { hasText: "recovered" }),
    ).toBeVisible({ timeout: 30_000 });

    // Sanity-check the value lives in the kernel namespace too.
    const editor = launched.window.getByRole("textbox", { name: "Editor content" });
    await editor.focus();
    await launched.window.keyboard.type("pdv_tree['recovered']");
    await launched.window.getByRole("button", { name: "Execute" }).click();
    await expect(launched.window.locator(".log-result").last()).toHaveText("42", { timeout: 15_000 });
  } finally {
    await launched.cleanup();
  }
});

test("orphan with module manifest is restored on Recover", async () => {
  const launched = await launchPDV({
    onBeforeLaunch: async (homeDir) => {
      const workingBase = path.join(homeDir, ".PDV", "working");
      const sessionDir = await makeAutosaveOrphan(workingBase, { recovered: 7 });
      // Add a minimal in-session module to the orphan's autosave so the
      // recovery code's "copy project.json" + "copy modules/" branches both
      // run. Schema fields here mirror project-manager.ts's ProjectManifest.
      const autosaveDir = path.join(sessionDir, ".autosave");
      const manifest = JSON.parse(
        await fs.readFile(path.join(autosaveDir, "project.json"), "utf8"),
      );
      manifest.modules = [
        { module_id: "mod_e2e", alias: "mod_e2e", version: "0.0.1", origin: "in_session" },
      ];
      await fs.writeFile(
        path.join(autosaveDir, "project.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      const moduleDir = path.join(autosaveDir, "modules", "mod_e2e");
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(
        path.join(moduleDir, "pdv-module.json"),
        JSON.stringify(
          {
            module_id: "mod_e2e",
            name: "mod_e2e",
            version: "0.0.1",
            language: "python",
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(
        path.join(moduleDir, "module-index.json"),
        JSON.stringify({ entries: [] }, null, 2),
        "utf8",
      );
    },
  });
  try {
    await clickRecoverAndWaitForKernel(launched.window);

    // The tree value still lands; the modules/ copy in recovery is a no-op
    // for the user-visible state, but if the copy throws we'd see a fail.
    await expect(
      launched.window.locator(".tree-row", { hasText: "recovered" }),
    ).toBeVisible({ timeout: 30_000 });

    const editor = launched.window.getByRole("textbox", { name: "Editor content" });
    await editor.focus();
    await launched.window.keyboard.type("pdv_tree['recovered']");
    await launched.window.getByRole("button", { name: "Execute" }).click();
    await expect(launched.window.locator(".log-result").last()).toHaveText("7", { timeout: 15_000 });
  } finally {
    await launched.cleanup();
  }
});
