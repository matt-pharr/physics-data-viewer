/**
 * Playwright configuration for PDV E2E tests.
 *
 * Runs against the production Electron bundle (`dist/main/bootstrap.js` +
 * `renderer/dist/index.html`). The Vite dev server is never used here —
 * E2E pins the same artifacts that ship to users.
 *
 * Workers are forced to 1 because each spec spawns a real Electron app
 * and a real Python kernel that share temp dirs and the user-config
 * surface; running them in parallel introduces hard-to-debug races.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"], ["html", { open: "never" }]],
});
