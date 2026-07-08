/**
 * new-project.ts — Start a new Python project through the setup dialog.
 *
 * Since the New Project dialog landed, clicking "New Python Project" on the
 * welcome screen opens a setup dialog (Python version, packages, advanced
 * existing-env option) instead of booting a kernel directly. Every spec that
 * cold-starts a project goes through this helper so the extra Create click
 * lives in one place.
 */

import type { Page } from "@playwright/test";

/**
 * Click "New Python Project" on the welcome screen, then confirm the setup
 * dialog with its defaults (Python version + default packages), which kicks
 * off the uv environment build and kernel boot.
 */
export async function createNewPythonProject(window: Page): Promise<void> {
  await window.getByRole("button", { name: "New Python Project" }).click();
  await window.getByTestId("new-project-create").click();
}
