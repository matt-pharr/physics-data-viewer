/**
 * crash-restart.spec.ts — Recovering a crashed session from the status bar.
 *
 * Regression coverage for the crash-recovery fixes (§11.6):
 * - The ⟳ Restart control must appear when the session dies (it used to
 *   render only while connected — gone exactly when needed).
 * - The crash handler must NOT delete the working directory (it used to,
 *   destroying the uv env spec and any `.autosave` snapshot).
 * - Restart after a crash reloads the tree from the last autosave and says
 *   so in the console.
 *
 * Flow: new project → value in tree → force an autosave → kill the kernel
 * process from inside itself → Disconnected + Restart visible → click →
 * session returns with the tree restored and live.
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

test("crashed session restarts from the status bar and restores the tree", async () => {
  test.setTimeout(180_000);
  const { window } = launched;

  // Put a value in the tree.
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  await window.keyboard.type("pdv_tree['crash_survivor'] = 456");
  await window.getByRole("button", { name: "Execute" }).click();
  await expect(
    window.locator(".tree-row", { hasText: "crash_survivor" }),
  ).toBeVisible({ timeout: 30_000 });

  // Force an autosave so the crash-restart has a snapshot to restore from
  // (the timer autosave would do this eventually; the test can't wait 5 min).
  await window.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).pdv.autosave.run({ tabs: [], activeTabId: 1 });
  });

  // Kill the kernel process from inside itself — a hard crash, not a stop.
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.type("import os, signal; os.kill(os.getpid(), signal.SIGKILL)");
  await window.getByRole("button", { name: "Execute" }).click();

  // The crash push flips the status to error ("Disconnected") — and the
  // restart control must be offered in exactly this state.
  const status = window.locator('[data-testid="kernel-status"]');
  await expect(status).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  const restart = window.locator('[data-testid="restart-session"]');
  await expect(restart).toBeVisible();

  // Restart and wait for the new session.
  await restart.click();
  await expect(status).toHaveAttribute("data-status", "starting", { timeout: 30_000 });
  await expectKernelReady(window);

  // The console reports what came back...
  await expect(window.locator(".log-stdout").first()).toContainText(
    /restored from the last autosave/i,
    { timeout: 30_000 },
  );

  // ...the tree value survived...
  await expect(
    window.locator(".tree-row", { hasText: "crash_survivor" }),
  ).toBeVisible({ timeout: 30_000 });

  // ...and is live in the new session.
  await editor.focus();
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.type("pdv_tree['crash_survivor']");
  await window.getByRole("button", { name: "Execute" }).click();
  await expect(window.locator(".log-result").last()).toHaveText("456", {
    timeout: 30_000,
  });
});
