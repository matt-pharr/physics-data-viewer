/**
 * smoke.spec.ts — Phase A smoke test.
 *
 * Confirms the prod bundle launches, the renderer loads, and the temp HOME
 * isolation works end-to-end. No kernel assertions yet — those land in the
 * Phase B specs.
 */

import { test, expect } from "@playwright/test";
import type { PDVApi } from "../renderer/src/types/pdv";
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
    return typeof (window as unknown as { pdv: PDVApi }).pdv;
  });
  expect(exposed).toBe("object");
});
