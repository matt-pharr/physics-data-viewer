/**
 * script-run.spec.ts — Phase C-extra spec.
 *
 * Drives the tree-script execution path end-to-end:
 * 1. Create a script via the tree context menu (covered earlier in B3).
 * 2. Overwrite the stub on disk with a body that produces an observable side
 *    effect (writes a known value into pdv_tree).
 * 3. Right-click the script row → "Run defaults" so the renderer dispatches
 *    `pdv.script.run` for the `tree-script` origin (no parameter dialog).
 * 4. Assert the side effect lands by reading `pdv_tree['written']` from a
 *    code cell.
 *
 * Catches regressions in: tree.createScript file write, comm-router script
 * registration, the run_defaults code path in app/index.tsx, and the
 * `pdv.script.run` IPC handler that builds the language-appropriate
 * invocation string.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs/promises";
import type { PDVApi } from "../renderer/src/types/pdv";
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

test("create script → overwrite body → run defaults → side effect lands in tree", async () => {
  const { window } = launched;

  // Create the script via the same renderer API the dialog uses. We bypass
  // the CreateScriptDialog UI here — B3 already covers it — because the
  // renderer doesn't expose the scriptPath to us through the dialog flow,
  // and we need the on-disk path to overwrite the stub.
  const scriptPath = await window.evaluate(async () => {
    const pdv = (window as unknown as { pdv: PDVApi }).pdv;
    const kernels = await pdv.kernels.list();
    const kernelId = kernels[0]?.id;
    if (!kernelId) throw new Error("no active kernel");
    const result = await pdv.tree.createScript(kernelId, "", "write_demo");
    if (!result?.success) throw new Error(result?.error ?? "createScript failed");
    if (!result.scriptPath) throw new Error("createScript returned no scriptPath");
    return result.scriptPath;
  });
  expect(scriptPath).toBeTruthy();

  // The new script row should appear after tree.changed lands.
  await expect(window.locator(".tree-row", { hasText: "write_demo" })).toBeVisible({ timeout: 15_000 });

  // Overwrite the stub. The default stub returns `{}`; we want an observable
  // mutation of pdv_tree so we can assert the script actually ran.
  await fs.writeFile(
    scriptPath!,
    [
      'def run(pdv_tree: dict) -> dict:',
      '    pdv_tree["written"] = 7',
      '    return {"ok": True}',
      '',
    ].join('\n'),
    'utf8',
  );

  // Right-click the script and pick "Run defaults".
  await window.locator(".tree-row", { hasText: "write_demo" }).click({ button: "right" });
  await window.locator(".context-menu-item", { hasText: "Run defaults" }).click();

  // The script wrote pdv_tree["written"] = 7; verify by evaluating in a code cell.
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type("pdv_tree['written']");
  await window.getByRole("button", { name: "Execute" }).click();

  // The script run also logs its own result (`{'ok': True}`) before our cell
  // runs, so anchor on the LAST log-result entry.
  await expect(window.locator(".log-result").last()).toHaveText("7", { timeout: 15_000 });
});
