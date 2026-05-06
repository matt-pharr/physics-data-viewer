/**
 * smoke.spec.ts — Phase A smoke test.
 *
 * Confirms the prod bundle launches, the renderer loads, and the temp HOME
 * isolation works end-to-end. No kernel assertions yet — those land in the
 * Phase B specs.
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

test("Electron launches the prod bundle", async () => {
  const title = await launched.window.title();
  expect(title.length).toBeGreaterThan(0);
});

test("preload exposes window.pdv to the renderer", async () => {
  const exposed = await launched.window.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof (window as any).pdv;
  });
  expect(exposed).toBe("object");
});
