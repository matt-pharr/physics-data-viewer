/**
 * startup.spec.ts — Phase B1 spec.
 *
 * Drives the cold-start path: Welcome screen → New Python Project → kernel
 * reaches ready. Catches preload regressions, kernel boot misconfig, and any
 * regression in the welcome → kernel handshake.
 */

import { test, expect } from "@playwright/test";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { createNewPythonProject } from "./helpers/new-project";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV();
});

test.afterAll(async () => {
  await launched?.cleanup();
});

test("welcome screen is visible on startup", async () => {
  const { window } = launched;
  await expect(window.getByText("Physics Data Viewer", { exact: true })).toBeVisible();
  await expect(window.getByRole("button", { name: "New Python Project" })).toBeVisible();
});

test("clicking New Python Project boots a kernel and reaches Connected", async () => {
  const { window } = launched;
  await createNewPythonProject(window);

  // The kernel transitions: disconnected → starting → ready. Assert against
  // the underlying state machine value via `data-status` so a UI copy change
  // doesn't break this spec.
  await expectKernelReady(window);
});

test("with a session running, the Default Runtime tab is future-sessions-only (§10.5.19)", async () => {
  const { window } = launched;
  // Depends on the previous test's booted kernel (tests in this file run in
  // order against one app instance).
  await expectKernelReady(window);

  // Open Settings → Default Runtime via the status-bar runtime chip.
  await window.getByTestId("runtime-chip").click();
  await expect(window.getByTestId("runtime-future-note")).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId("runtime-future-note")).toContainText(/future sessions/i);
  // Close settings so later specs start from a clean UI.
  await window.getByRole("button", { name: "Close settings" }).click();
});
