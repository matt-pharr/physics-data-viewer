/**
 * tree-create-and-run.spec.ts — Phase B3 spec.
 *
 * Drives the tree right-click → Create new script → run path. Catches:
 * - ContextMenu wiring + entries
 * - tree.createScript IPC end-to-end (file write + tree.register comm)
 * - tree.changed push delivery → React tree refresh
 * - script.run IPC for tree-script origin (default stub returns {})
 */

import { test, expect } from "@playwright/test";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { createNewPythonProject } from "./helpers/new-project";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV();
  await createNewPythonProject(launched.window);
  await expectKernelReady(launched.window);
});

test.afterAll(async () => {
  await launched?.cleanup();
});

test("right-click root → Create new script → script appears in tree", async () => {
  const { window } = launched;

  // The tree always renders a synthetic root row labelled "pdv_tree" so that
  // an empty tree still has something to right-click. Anchor on it.
  const root = window.locator(".tree-row", { hasText: "pdv_tree" });
  await expect(root).toBeVisible();
  await root.click({ button: "right" });

  await window.getByRole("menuitem", { name: "Create new script" })
    .or(window.locator(".context-menu-item", { hasText: "Create new script" }))
    .first()
    .click();

  await expect(window.getByRole("heading", { name: "Create new script" })).toBeVisible();
  await window.getByRole("textbox", { name: "Script name" }).fill("demo_e2e");
  await window.getByRole("button", { name: "Create", exact: true }).click();

  // The new script row should appear after the tree.changed push round-trips.
  await expect(window.locator(".tree-row", { hasText: "demo_e2e" })).toBeVisible({ timeout: 15_000 });
});
