/**
 * kernel-status.ts — Stable selector + waiter for the kernel status indicator.
 *
 * The status bar element renders user-visible text that changes ("Connected",
 * "Disconnected", "Starting…") with the kernel state. Specs assert against the
 * underlying state machine via `data-status` rather than the localized label,
 * so a UI copy change doesn't cascade into every E2E spec.
 */

import { expect, type Page } from "@playwright/test";

/** Locator for the kernel-status indicator in the status bar. */
export function kernelStatus(window: Page) {
  return window.locator('[data-testid="kernel-status"]');
}

/** Wait for the kernel to transition to `ready` (the `Connected` UI state). */
export async function expectKernelReady(window: Page, timeoutMs = 60_000): Promise<void> {
  await expect(kernelStatus(window)).toHaveAttribute("data-status", "ready", { timeout: timeoutMs });
}
