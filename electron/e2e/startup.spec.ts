/**
 * startup.spec.ts — Phase B1 spec.
 *
 * Drives the cold-start path: Welcome screen → New Python Project → kernel
 * reaches ready. Catches preload regressions, kernel boot misconfig, and any
 * regression in the welcome → kernel handshake.
 */

import { test, expect } from "@playwright/test";
import { launchPDV, type LaunchedApp } from "./helpers/launch";

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
  await window.getByRole("button", { name: "New Python Project" }).click();

  // The status bar text flips from "Disconnected" → "Starting..." → "Connected"
  // once the kernel handshake completes. Anchor on the leading bullet glyph so
  // we don't accidentally match "Disconnected".
  await expect(window.getByText(/●\s+Connected\b/)).toBeVisible({ timeout: 60_000 });
});
