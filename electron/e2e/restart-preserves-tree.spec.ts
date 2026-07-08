/**
 * restart-preserves-tree.spec.ts — Restarting the session keeps the tree.
 *
 * Regression coverage for the restart data-loss fix: restarting used to
 * wipe the in-memory tree (unsaved sessions entirely; saved projects
 * reverted to their last explicit save). The restart flow now snapshots
 * the tree into `.autosave` while the old session is still alive and
 * restores it into the new one, and the StatusBar exposes the Restart
 * control that drives it.
 *
 * Flow: new unsaved project → put a value in the tree → StatusBar
 * Restart → session comes back → the value is still in the tree and
 * still readable from a code cell.
 */

import { test, expect } from "@playwright/test";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV();
  await launched.window.getByRole("button", { name: "New Python Project" }).click();
  await expectKernelReady(launched.window);
});

test.afterAll(async () => {
  await launched?.cleanup();
});

test("tree survives a session restart in an unsaved project", async () => {
  test.setTimeout(180_000);
  const { window } = launched;

  // Put a value in the tree and confirm it shows up.
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  await window.keyboard.type("pdv_tree['restart_survivor'] = 123");
  await window.getByRole("button", { name: "Execute" }).click();
  await expect(
    window.locator(".tree-row", { hasText: "restart_survivor" }),
  ).toBeVisible({ timeout: 30_000 });

  // Restart via the StatusBar control. Wait for the status to leave
  // "ready" so the follow-up ready-wait can't pass on the old session.
  const status = window.locator('[data-testid="kernel-status"]');
  await window.locator('[data-testid="restart-session"]').click();
  await expect(status).toHaveAttribute("data-status", "starting", {
    timeout: 30_000,
  });
  await expectKernelReady(window);

  // The tree value must have survived the restart...
  await expect(
    window.locator(".tree-row", { hasText: "restart_survivor" }),
  ).toBeVisible({ timeout: 30_000 });

  // ...and be live in the new session, not just displayed.
  await editor.focus();
  await window.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await window.keyboard.type("pdv_tree['restart_survivor']");
  await window.getByRole("button", { name: "Execute" }).click();
  await expect(window.locator(".log-result").last()).toHaveText("123", {
    timeout: 30_000,
  });
});
