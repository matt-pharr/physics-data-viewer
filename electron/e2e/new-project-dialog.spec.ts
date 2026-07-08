/**
 * new-project-dialog.spec.ts — Creation-time environment setup (§10.5.8).
 *
 * The New Project dialog is the creation-time home of the environment
 * choice: Python version (pinned via uv's `.python-version`), initial
 * packages, and (behind Advanced) an existing shared environment. This spec
 * pins the default uv path end to end:
 *
 * 1. Welcome → New Python Project opens the dialog with the defaults
 *    (default version preselected, default packages prefilled).
 * 2. Create boots a uv kernel.
 * 3. Saving records `environment.mode: "uv"` + a resolved `python_version`
 *    in project.json, and the `.python-version` pin lands in the save dir.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV();
});

test.afterAll(async () => {
  await launched?.cleanup();
});

test("dialog defaults → uv project → manifest records environment", async () => {
  test.setTimeout(180_000);
  const { window } = launched;
  const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-newproj-"));

  try {
    // ── 1. The welcome button opens the dialog with defaults ─────────────
    await window.getByRole("button", { name: "New Python Project" }).click();
    const dialog = window.getByTestId("new-project-dialog");
    await expect(dialog).toBeVisible();
    // Default packages prefilled from config (numpy, matplotlib).
    await expect(window.getByTestId("new-project-packages")).toHaveValue(
      /numpy.*matplotlib/,
    );

    // ── 2. Create with defaults boots a uv kernel ────────────────────────
    await window.getByTestId("new-project-create").click();
    await expect(dialog).toBeHidden();
    await expectKernelReady(window);

    // ── 3. Save → manifest + pin land in the save dir ────────────────────
    await sendMenuAction(launched.app, { action: "project:save", path: saveDir });
    await expect
      .poll(async () => {
        try {
          await fs.stat(path.join(saveDir, "project.json"));
          return true;
        } catch {
          return false;
        }
      }, { timeout: 30_000 })
      .toBe(true);

    const manifest = JSON.parse(
      await fs.readFile(path.join(saveDir, "project.json"), "utf8"),
    ) as {
      environment?: { mode?: string; python_version?: string };
      interpreter_path?: string;
    };
    expect(manifest.environment?.mode).toBe("uv");
    // Resolved from the live venv interpreter at kernel start.
    expect(manifest.environment?.python_version).toMatch(/^3\.\d+$/);
    // uv projects never record an interpreter path — the venv is ephemeral.
    expect(manifest.interpreter_path).toBeUndefined();

    // The uv version pin rides ENV_FILES into the save dir.
    const pin = await fs.readFile(path.join(saveDir, ".python-version"), "utf8");
    expect(pin.trim()).toMatch(/^3\.\d+$/);
  } finally {
    await fs.rm(saveDir, { recursive: true, force: true });
  }
});
