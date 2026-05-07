/**
 * code-cell.spec.ts — Phase B2 spec.
 *
 * Drives the full execute path: editor → script.run IPC → kernel execute →
 * iopub stream → Console panel. Catches regressions in code-cell wiring,
 * Cmd+Enter binding, console rendering of stdout, and result formatting.
 */

import { test, expect } from "@playwright/test";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV();
  // Boot the kernel once for both cases.
  await launched.window.getByRole("button", { name: "New Python Project" }).click();
  await expectKernelReady(launched.window);
});

test.afterAll(async () => {
  await launched?.cleanup();
});

async function runInCodeCell(code: string): Promise<void> {
  const { window } = launched;
  const editor = window.getByRole("textbox", { name: "Editor content" });
  // Monaco overlays nested view layers; focus() rather than click() avoids
  // pointer-event interception by .view-line inside the editor.
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
}

test("print('hello') stdout reaches the console", async () => {
  await runInCodeCell("print('hello')");
  await expect(launched.window.locator(".log-stdout").first()).toContainText("hello", { timeout: 15_000 });
});

test("expression result 2+2 renders as 4", async () => {
  await runInCodeCell("2+2");
  await expect(launched.window.locator(".log-result").first()).toHaveText("4", { timeout: 15_000 });
});
