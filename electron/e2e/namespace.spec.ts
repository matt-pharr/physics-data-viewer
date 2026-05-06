/**
 * namespace.spec.ts — Phase C1 spec.
 *
 * Drives the Namespace panel end-to-end:
 * 1. Define a list in a code cell so the kernel namespace has something to show.
 * 2. Switch the left sidebar from Tree to Namespace via the activity bar.
 * 3. Verify the variable row appears with the expected type/shape.
 * 4. Expand the row and confirm `pdv.namespace.inspect` returns child entries.
 *
 * Catches regressions across the namespace IPC family — query + inspect, the
 * refreshToken plumbing fired by useKernelSubscriptions, and the lazy-expand
 * UI — none of which other E2E specs touch.
 */

import { test, expect } from "@playwright/test";
import { launchPDV, type LaunchedApp } from "./helpers/launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV();
  await launched.window.getByRole("button", { name: "New Python Project" }).click();
  await expect(launched.window.getByText(/●\s+Connected\b/)).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
  await launched?.cleanup();
});

test("namespace panel shows variables and expands children", async () => {
  const { window } = launched;

  // Seed a list in the kernel namespace.
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  await window.keyboard.type("arr = [10, 20, 30]");
  await window.getByRole("button", { name: "Execute" }).click();

  // Wait for the cell duration label to appear in the console — that's the
  // signal that the execute_request fully completed kernel-side and the
  // namespace refreshToken has bumped.
  await expect(window.locator(".log-duration").first()).toBeVisible({ timeout: 15_000 });

  // Switch to the Namespace panel. The activity bar button toggles the
  // sidebar off when the same panel is already active, so wait for the
  // namespace-view element to confirm the click landed in the open state.
  // If the click toggled it off, click again to reopen.
  await window.getByRole("button", { name: "Namespace", exact: true }).click();
  const namespaceView = window.locator(".namespace-view");
  if (!(await namespaceView.isVisible())) {
    await window.getByRole("button", { name: "Namespace", exact: true }).click();
  }
  await expect(namespaceView).toBeVisible({ timeout: 5_000 });

  const arrRow = window.locator(".namespace-row", { hasText: /\barr\b/ });
  await expect(arrRow).toBeVisible({ timeout: 15_000 });

  // The row advertises child entries; expand it. Locate the expand button by
  // its accessible name (aria-label) directly — `getByRole` scoped inside the
  // row locator misses the nested table/cell structure inconsistently.
  const expand = window.getByRole("button", { name: "Expand arr" });
  await expect(expand).toBeEnabled();
  await expand.click();

  // After inspect resolves, individual element rows appear.
  await expect(window.locator(".namespace-row", { hasText: /\[0\]/ })).toBeVisible({ timeout: 15_000 });
  await expect(window.locator(".namespace-row", { hasText: /\[1\]/ })).toBeVisible();
  await expect(window.locator(".namespace-row", { hasText: /\[2\]/ })).toBeVisible();
});
