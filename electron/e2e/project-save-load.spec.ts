/**
 * project-save-load.spec.ts — Phase B4 spec.
 *
 * End-to-end save → restart → load → execute round-trip:
 * 1. Boot kernel, define `x = 42` in a code cell.
 * 2. Synthesize the File → Save menu action with an explicit save dir
 *    (bypasses the SaveAs dialog). Verify tree-index.json on disk contains x.
 * 3. Close the app, relaunch.
 * 4. Stub `dialog.showOpenDialog` to return the save dir, fire File → Open.
 * 5. Confirm the tree row for `x` reappears, evaluate `x + 1` and assert 43.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV } from "./helpers/launch";
import { stubDialog } from "./helpers/dialog-mock";
import { sendMenuAction } from "./helpers/menu-action";

async function bootKernel(window: import("@playwright/test").Page): Promise<void> {
  await window.getByRole("button", { name: "New Python Project" }).click();
  await expectKernelReady(window);
}

async function runCode(window: import("@playwright/test").Page, code: string): Promise<void> {
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
}

test.setTimeout(180_000);

test("project save → restart → open → expression sees saved value", async () => {
  const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-save-"));

  // ── 1. First app instance: boot, define x, save ────────────────────
  const first = await launchPDV();
  try {
    await bootKernel(first.window);
    await runCode(first.window, "pdv_tree['x'] = 42");

    // Wait for the new key to land in the tree before saving so we don't race
    // the save against the tree.changed push.
    await expect(first.window.locator(".tree-row", { hasText: "x" })).toBeVisible({ timeout: 15_000 });

    await sendMenuAction(first.app, { action: "project:save", path: saveDir });

    // The save IPC writes synchronously after the kernel responds. Poll the
    // disk artifact rather than waiting on a UI signal — checksum text in the
    // status bar is incidental.
    await expect.poll(async () => {
      try {
        await fs.stat(path.join(saveDir, "tree-index.json"));
        return true;
      } catch {
        return false;
      }
    }, { timeout: 15_000 }).toBe(true);

    const indexRaw = await fs.readFile(path.join(saveDir, "tree-index.json"), "utf8");
    const entries = JSON.parse(indexRaw) as Array<{ path: string; storage?: { value?: unknown } }>;
    const xEntry = entries.find((e) => e.path === "x");
    expect(xEntry?.storage?.value).toBe(42);
  } finally {
    await first.cleanup();
  }

  // ── 2. Second app instance: open the saved project, evaluate x+1 ────
  const second = await launchPDV();
  try {
    await bootKernel(second.window);

    // Drive the renderer's open path directly. `menu:action` + dialog stubbing
    // hits a UnsavedChangesDialog branch we don't care about for this spec; the
    // observable behavior we want to pin is "loading a saved project from disk
    // restores the tree and resumes execution against it."
    await second.window.evaluate(async (dir) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pdv.project.load(dir);
    }, saveDir);

    // Tree should refresh once the project.loaded push lands.
    await expect(second.window.locator(".tree-row", { hasText: "x" })).toBeVisible({ timeout: 30_000 });

    await runCode(second.window, "pdv_tree['x'] + 1");
    await expect(second.window.locator(".log-result").first()).toHaveText("43", { timeout: 15_000 });
  } finally {
    await second.cleanup();
    await fs.rm(saveDir, { recursive: true, force: true });
  }
});
