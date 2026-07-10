/**
 * console-autoscroll.spec.ts — verifies the Console panel's
 * pin-to-bottom auto-scroll behavior.
 *
 * Three properties are exercised:
 *   1. Streaming output keeps the viewport pinned to the bottom even
 *      while a single LogEntry's stdout grows (the array length stays
 *      constant, so the previous useEffect([logs.length]) regression
 *      would not have scrolled).
 *   2. Scrolling up disengages the auto-scroll — subsequent output
 *      arrives without yanking the user back down.
 *   3. Scrolling back to the bottom re-engages the pin so the next
 *      chunk follows again.
 */

import { test, expect } from "@playwright/test";
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

async function runInCodeCell(code: string): Promise<void> {
  const { window } = launched;
  const editor = window.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  // Type as a single keystroke per character — Monaco swallows multi-line
  // paste through keyboard.type but accepts \n as Enter.
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
}

/** Returns ``scrollHeight - scrollTop - clientHeight`` for the Console
 *  scroll container — i.e. distance in pixels from the bottom. The
 *  Console pins when this is ≤ 4. */
async function distanceFromBottom(): Promise<number> {
  return launched.window.locator(".console-content").evaluate((el) => {
    const div = el as HTMLDivElement;
    return div.scrollHeight - div.scrollTop - div.clientHeight;
  });
}

test("streaming output keeps the console pinned to the bottom", async () => {
  // 500 lines is more than tall enough to overflow the panel and force
  // a scrollbar; the bug only appears when there's something to scroll.
  await runInCodeCell("for i in range(500): print(i)");
  // Wait for the last printed value to render — Console virtualizes
  // nothing here, so it lands in the DOM verbatim.
  await expect(
    launched.window.locator(".log-stdout").first()
  ).toContainText("499", { timeout: 30_000 });

  // After streaming completes, the panel should be at (or within the
  // PIN_THRESHOLD_PX of) the bottom.
  const distance = await distanceFromBottom();
  expect(distance).toBeLessThanOrEqual(4);
});

test("scrolling up disengages auto-scroll, scrolling back re-engages", async () => {
  // Scroll the console up a meaningful distance, then send more output
  // and confirm the viewport did NOT jump to the bottom.
  await launched.window.locator(".console-content").evaluate((el) => {
    (el as HTMLDivElement).scrollTop = 0;
  });
  // Yield a frame so the onScroll handler updates pinnedToBottomRef.
  await launched.window.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

  await runInCodeCell("for i in range(200): print('extra', i)");
  // Wait for the streamed output to actually land (its last line renders in
  // the DOM) instead of a blind sleep, then assert the viewport did NOT jump
  // to the bottom — auto-scroll must stay disengaged while the user reads.
  await expect(
    launched.window.locator(".log-stdout").last()
  ).toContainText("extra 199", { timeout: 30_000 });
  const scrolledUpDistance = await distanceFromBottom();
  expect(scrolledUpDistance).toBeGreaterThan(50);

  // Scroll back to the bottom and send one more execution; the pin
  // should re-engage.
  await launched.window.locator(".console-content").evaluate((el) => {
    const div = el as HTMLDivElement;
    div.scrollTop = div.scrollHeight;
  });
  await launched.window.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

  await runInCodeCell("for i in range(200): print('final', i)");
  await expect(
    launched.window.locator(".log-stdout").last()
  ).toContainText("final 199", { timeout: 30_000 });
  const reengaged = await distanceFromBottom();
  expect(reengaged).toBeLessThanOrEqual(4);
});
