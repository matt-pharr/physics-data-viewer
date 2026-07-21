/**
 * round-trip-budget.spec.ts — the renderer's latency discipline, executable.
 *
 * Remote mode turns every `window.pdv` invoke into a network round trip, so
 * the renderer must never be chatty: idle traffic is O(1) per poll tick
 * (one `tree:getVersion`, never per-expanded-level listings), and a cell
 * run costs the execute plus one parallel revalidation wave. This spec
 * counts real IPC invokes (per-channel counters recorded by the preload
 * under PDV_E2E=1) and fails if the budget regresses — e.g. if someone
 * reintroduces a listing-based poll or an ad-hoc refetch loop.
 *
 * Budgets are deliberately generous enough to absorb timing jitter (an
 * extra poll tick landing inside the window) while remaining far below the
 * old behavior they guard against (the pre-#233 poll issued
 * (1 + expanded) serial listings every second — ~15+ listings per 5 s
 * window where this spec allows zero).
 */

import { test, expect, type Page } from "@playwright/test";
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

async function invokeCounts(window: Page): Promise<Record<string, number>> {
  return window.evaluate(() =>
    (window as unknown as { pdv: { system: { getInvokeCounts(): Record<string, number> } } })
      .pdv.system.getInvokeCounts(),
  );
}

function delta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [channel, count] of Object.entries(after)) {
    const diff = count - (before[channel] ?? 0);
    if (diff > 0) out[channel] = diff;
  }
  return out;
}

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

test("idle app with expanded tree costs one version check per tick, no listings", async () => {
  test.setTimeout(120_000);
  const { window } = launched;

  // Seed a two-level tree and expand both levels, so the old
  // per-expanded-level poll would be maximally visible.
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  await window.keyboard.type(
    "pdv_tree['grp'] = {'inner': {'leaf': 1}, 'x': 2}",
  );
  await window.getByRole("button", { name: "Execute" }).click();
  const grpRow = window.locator(".tree-row", { hasText: "grp" }).first();
  await expect(grpRow).toBeVisible({ timeout: 30_000 });
  await grpRow.getByRole("button", { name: /Expand/ }).click();
  const innerRow = window.locator(".tree-row", { hasText: "inner" }).first();
  await expect(innerRow).toBeVisible({ timeout: 15_000 });
  await innerRow.getByRole("button", { name: /Expand/ }).click();
  await expect(window.locator(".tree-row", { hasText: "leaf" })).toBeVisible({
    timeout: 15_000,
  });

  // Let post-execution invalidation and push suppression settle.
  await window.waitForTimeout(4_000);

  const before = await invokeCounts(window);
  await window.waitForTimeout(5_000); // ~2–3 poll ticks
  const idle = delta(before, await invokeCounts(window));

  // The whole idle window: version checks only. Zero listings, zero
  // namespace traffic, and O(1) total regardless of expansion depth.
  expect(idle["tree:list"] ?? 0).toBe(0);
  expect(idle["namespace:query"] ?? 0).toBe(0);
  expect(idle["tree:getVersion"] ?? 0).toBeLessThanOrEqual(4);
  expect(sum(idle)).toBeLessThanOrEqual(5);
});

test("a cell run costs the execute plus one bounded revalidation wave", async () => {
  test.setTimeout(120_000);
  const { window } = launched;
  const editor = window.getByRole("textbox", { name: "Editor content" });

  const before = await invokeCounts(window);

  await editor.focus();
  await window.keyboard.press(
    process.platform === "darwin" ? "Meta+a" : "Control+a",
  );
  await window.keyboard.type("x_budget = 1");
  await window.getByRole("button", { name: "Execute" }).click();
  await expect(window.locator(".log-entry", { hasText: "x_budget" })).toBeVisible({
    timeout: 30_000,
  });
  // Allow the post-run invalidation wave (and any fingerprint ping) to land.
  await window.waitForTimeout(2_500);

  const run = delta(before, await invokeCounts(window));

  expect(run["kernels:execute"] ?? 0).toBe(1);
  // Revalidation: root + 2 expanded levels, in parallel — allow slack for a
  // push-driven wave on top, but nothing like a per-level serial reload.
  expect(run["tree:list"] ?? 0).toBeLessThanOrEqual(6);
  // Namespace panel is hidden: its queries are inactive and must not fetch.
  expect(run["namespace:query"] ?? 0).toBe(0);
  // Total budget for one trivial run, including poll ticks in the window.
  expect(sum(run)).toBeLessThanOrEqual(12);
});
