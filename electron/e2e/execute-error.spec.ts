/**
 * execute-error.spec.ts — Phase C-extra spec.
 *
 * Verify the renderer's error rendering pipeline end-to-end:
 *
 * 1. Run `1/0` in a code cell.
 * 2. Confirm the console log entry surfaces ZeroDivisionError + traceback.
 * 3. Confirm the kernel-side error makes it through `script.run`'s
 *    error path — `kernel-error-parser` parses the iopub `error` frame,
 *    `Console`'s `.log-error` and `.log-traceback` render it.
 *
 * No other E2E spec touches the failure path, and several non-trivial
 * subsystems live there: ANSI parsing, traceback rendering, and the
 * source-location bottom-bar attribution for code-cell origins.
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

test("ZeroDivisionError lands in the console with a traceback", async () => {
  const { window } = launched;

  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  await window.keyboard.type("1/0");
  await window.getByRole("button", { name: "Execute" }).click();

  // The console renders the kernel error in a `.log-error` block (the
  // exception name + message, ANSI-stripped) and a `.log-traceback` block.
  await expect(window.locator(".log-error").first()).toContainText("ZeroDivisionError", { timeout: 15_000 });
  await expect(window.locator(".log-traceback").first()).toContainText("ZeroDivisionError");

  // The error-context attribution row identifies which code cell produced
  // the error — important for users running multiple cells.
  await expect(window.locator(".log-error-context").first()).toContainText(/cell|line/i);
});
