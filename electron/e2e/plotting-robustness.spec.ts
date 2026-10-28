/**
 * plotting-robustness.spec.ts — PR B4 spec.
 *
 * Drives the remote plotting failure modes against a REAL local kernel using
 * pdv-python's `PDV_MPL_PLATFORM` test seam: the app launches with a forced
 * Linux decision path and a dead `DISPLAY` (`localhost:99.0` → TCP 6099,
 * where nothing listens), which is exactly the state a remote kernel daemon
 * is in after the ssh channel that set its DISPLAY dies.
 *
 * Asserts the three outcomes that define B4:
 *  1. Bootstrap lands on the inline backend instead of a GUI backend.
 *  2. Bare `plt.show()` renders an inline image in the console — no window,
 *     no silence.
 *  3. `%matplotlib qt` prints a one-line refusal and the kernel SURVIVES —
 *     the pre-B4 behavior was a C-level Qt abort killing the kernel.
 */

import { test, expect } from "@playwright/test";
import { expectKernelReady, kernelStatus } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { createNewPythonProject } from "./helpers/new-project";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV({
    env: {
      // pdv.mpl_config test seams: take the Linux probe/pre-flight path even
      // on a macOS dev machine or CI runner, and override what the KERNEL's
      // decision logic sees as $DISPLAY — never the real DISPLAY variable,
      // which on Linux CI is the xvfb display Electron itself needs (an
      // override there hangs the app launch; found the hard way on CI).
      PDV_MPL_PLATFORM: "linux",
      // The ssh X11-forwarding shape with nothing behind it: localhost:N
      // maps to TCP port 6000+N, and nothing listens on 6099.
      PDV_MPL_DISPLAY: "localhost:99.0",
    },
  });
  await createNewPythonProject(launched.window);
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

test("dead DISPLAY: bootstrap lands on the inline backend", async () => {
  await runInCodeCell("import matplotlib; print('backend=' + matplotlib.get_backend())");
  // Console entries append in DOM order — scope by text, never by position.
  await expect(
    launched.window.locator(".log-stdout", { hasText: "backend=inline" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("dead DISPLAY: bare plt.show() renders an inline console image", async () => {
  const { window } = launched;
  const imagesBefore = await window.locator(".log-image").count();
  await runInCodeCell(
    "import matplotlib.pyplot as plt\nplt.plot([1, 2, 4, 8])\nplt.show()",
  );
  await expect
    .poll(async () => window.locator(".log-image").count(), { timeout: 30_000 })
    .toBeGreaterThan(imagesBefore);
  // The plot must scroll INTO VIEW: an image decoding after the pin ran used
  // to leave the console stranded above it (looked like "nothing happened"),
  // and Chrome's scroll anchoring then latched auto-scroll off for good.
  // Poll past the async image decode; a pinned console sits within a few px
  // of the bottom.
  await expect
    .poll(
      async () =>
        window.evaluate(() => {
          const el = document.querySelector(".console-content");
          if (!el) return Number.NaN;
          return el.scrollHeight - el.scrollTop - el.clientHeight;
        }),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(8);
});

test("%matplotlib qt is refused with the kernel alive", async () => {
  const { window } = launched;
  await runInCodeCell("%matplotlib qt");
  // The guard prints its one-liner instead of letting Qt abort the process.
  await expect(
    window.locator(".log-stdout", { hasText: "refusing %matplotlib qt" }),
  ).toBeVisible({ timeout: 15_000 });
  // The kernel must still be serving — this is the line that failed (with
  // KernelCrashedError) before the guard existed.
  await expect(kernelStatus(window)).toHaveAttribute("data-status", "ready");
  const imagesBefore = await window.locator(".log-image").count();
  await runInCodeCell(
    "import matplotlib.pyplot as plt\nplt.plot([3, 1, 4, 1, 5])\nplt.show()\nprint('alive')",
  );
  await expect(
    window.locator(".log-stdout", { hasText: "alive" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => window.locator(".log-image").count(), { timeout: 30_000 })
    .toBeGreaterThan(imagesBefore);
});
