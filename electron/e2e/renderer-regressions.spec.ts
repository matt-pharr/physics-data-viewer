/**
 * renderer-regressions.spec.ts — Live regression pins for the renderer
 * correctness & snappiness pass (batch 4).
 *
 * Covers behaviors that only break against a real kernel:
 * 1. Tree right-click → Print builds the invocation in the main process
 *    (`tree:print`) and logs code + stdout in the Console.
 * 2. Plain-dict mutations (invisible to push) are picked up by the 1 Hz
 *    safety-net poll as an in-place patch — the expanded subtree gains the
 *    new child WITHOUT collapsing.
 * 3. Dirty note tabs flush on close — edits survive close + reopen.
 * 4. Namespace auto-refresh keeps user-expanded rows open across ticks.
 * 5. Long streamed output arrives intact through the 16 ms chunk
 *    coalescing (first and last lines both render).
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

async function runInCodeCell(code: string): Promise<void> {
  const { window } = launched;
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
  // The duration label signals the execute round-trip fully completed.
  await expect(window.locator(".log-duration").last()).toBeVisible({ timeout: 15_000 });
}

test("tree Print action logs main-built code and output in the console", async () => {
  const { window } = launched;

  await runInCodeCell('pdv_tree["greeting"] = "hello-print-e2e"');
  const row = window.locator(".tree-row", { hasText: "greeting" });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.click({ button: "right" });
  await window.locator(".context-menu-item", { hasText: "Print" }).first().click();

  // The invocation string is built in the main process (tree:print) and
  // echoed into the console entry alongside the kernel's stdout.
  await expect(window.locator(".log-code", { hasText: 'print(pdv_tree["greeting"])' }))
    .toBeVisible({ timeout: 15_000 });
  await expect(window.locator(".log-stdout", { hasText: "hello-print-e2e" }).last())
    .toBeVisible({ timeout: 15_000 });
});

test("plain-dict mutation is patched in by the poll without collapsing the subtree", async () => {
  const { window } = launched;

  // A plain dict stored in the tree has no push machinery — only the 1 Hz
  // poll can see mutations inside it (ARCHITECTURE.md §7.4.2).
  await runInCodeCell('pdv_tree["data"] = {"alpha": 1}');
  const dataRow = window.locator(".tree-row", { hasText: "data" }).first();
  await expect(dataRow).toBeVisible({ timeout: 15_000 });

  await window.getByRole("button", { name: "Expand data" }).click();
  await expect(window.locator(".tree-row", { hasText: "alpha" })).toBeVisible({ timeout: 15_000 });

  // Mutate the plain dict in place — this emits no tree.changed push.
  await runInCodeCell('pdv_tree["data"]["beta"] = 2');

  // The poll must surface the new child within a couple of ticks…
  await expect(window.locator(".tree-row", { hasText: "beta" })).toBeVisible({ timeout: 10_000 });
  // …and the patch must not have collapsed the expanded subtree.
  await expect(window.locator(".tree-row", { hasText: "alpha" })).toBeVisible();
});

test("dirty note tab flushes on close — edits survive close + reopen", async () => {
  const { window } = launched;

  // Create a note at the root.
  const root = window.locator(".tree-row", { hasText: "pdv_tree" });
  await root.click({ button: "right" });
  await window.locator(".context-menu-item", { hasText: "Create new note" }).first().click();
  await window.getByRole("textbox", { name: "Note name" }).fill("note_e2e");
  await window.getByRole("button", { name: "Create", exact: true }).click();

  const noteRow = window.locator(".tree-row", { hasText: "note_e2e" });
  await expect(noteRow).toBeVisible({ timeout: 15_000 });

  // Open it in the Write pane and type without waiting for any autosave.
  await noteRow.dblclick();
  const writePane = window.locator(".write-tab-pane");
  await expect(writePane).toBeVisible({ timeout: 10_000 });
  const noteEditor = writePane.getByRole("textbox").first();
  await noteEditor.focus();
  await window.keyboard.type("persisted-by-close-flush");

  // Close the dirty tab immediately — the close path must flush first.
  await window.getByRole("button", { name: "Close note_e2e", exact: true }).click();
  await expect(writePane).not.toBeVisible({ timeout: 10_000 });

  // Reopen and verify the edit survived.
  await noteRow.dblclick();
  await expect(writePane).toBeVisible({ timeout: 10_000 });
  await expect(writePane.locator(".view-lines")).toContainText("persisted-by-close-flush", {
    timeout: 10_000,
  });

  // Clean up: tab is no longer dirty, so this close is instant and returns
  // the center pane to Code for the following tests.
  await window.getByRole("button", { name: "Close note_e2e", exact: true }).click();
  await expect(writePane).not.toBeVisible({ timeout: 10_000 });
});

test("namespace auto-refresh keeps expanded rows open across ticks", async () => {
  const { window } = launched;

  await runInCodeCell("ns_arr = [10, 20, 30]");

  // Switch the sidebar to the Namespace panel (button toggles; reopen if
  // the first click closed an already-active panel).
  await window.getByRole("button", { name: "Namespace", exact: true }).click();
  const namespaceView = window.locator(".namespace-view");
  if (!(await namespaceView.isVisible())) {
    await window.getByRole("button", { name: "Namespace", exact: true }).click();
  }
  await expect(namespaceView).toBeVisible({ timeout: 5_000 });

  await window.getByRole("checkbox", { name: "Auto-refresh" }).check();

  const expand = window.getByRole("button", { name: "Expand ns_arr" });
  await expect(expand).toBeEnabled({ timeout: 15_000 });
  await expand.click();
  await expect(window.locator(".namespace-row", { hasText: /\[0\]/ })).toBeVisible({ timeout: 15_000 });

  // Grow the list, then wait for an auto-refresh tick to surface the new
  // element ([3]) under the still-expanded node. That both proves a refresh
  // cycle actually ran (rather than a blind sleep) and that it re-inspected
  // the expanded node — the old behavior reset all inspection state on every
  // tick, collapsing the row.
  await runInCodeCell("ns_arr.append(40)");
  await expect(window.locator(".namespace-row", { hasText: /\[3\]/ })).toBeVisible({ timeout: 15_000 });
  await expect(window.locator(".namespace-row", { hasText: /\[0\]/ })).toBeVisible();

  await window.getByRole("checkbox", { name: "Auto-refresh" }).uncheck();
  // Restore the Tree panel for any later specs.
  await window.getByRole("button", { name: /^Tree/ }).click();
  const treeContainer = window.locator(".tree-container");
  if (!(await treeContainer.isVisible())) {
    await window.getByRole("button", { name: /^Tree/ }).click();
  }
  await expect(treeContainer).toBeVisible({ timeout: 5_000 });
});

test("long streamed output arrives intact through chunk coalescing", async () => {
  const { window } = launched;

  await runInCodeCell('for i in range(2000):\n    print(f"line-{i}")');

  const stdout = window.locator(".log-stdout").last();
  await expect(stdout).toContainText("line-0", { timeout: 20_000 });
  // The tail must not be dropped by the 16 ms flush buffer (including the
  // final flush on stream end).
  await expect(stdout).toContainText("line-1999", { timeout: 20_000 });
});
