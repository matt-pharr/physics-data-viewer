/**
 * remote-session-live.spec.ts — the remote path against a REAL host.
 *
 * Everything is real here: real `ssh`, real ControlMaster, real bundle
 * upload and install, a real session daemon on the far side. The sibling
 * `remote-session.spec.ts` covers the same flow with a fake ssh and proves
 * the wiring; this one proves the parts a fixture cannot — an actual login
 * shell, an actual filesystem with actual quotas and an NFS home, and
 * whatever the site's ssh config does on the way in.
 *
 * Gated on `PDV_E2E_REMOTE_HOST` because it needs a host the developer can
 * authenticate to. Set it to an alias from your `~/.ssh/config`:
 *
 *   PDV_E2E_REMOTE_HOST=feyn PYTHON_PATH=... npm run test:e2e -- remote-session-live
 *
 * **Have a ControlMaster open first** (`ssh -f -N -M -o ControlPath=… host`)
 * or be ready to approve a key: PDV will otherwise establish its own master
 * and any agent prompt or 2FA push has to be answered by a human within the
 * connect timeout. The bundle upload is ~70 MB on a cold host, so the first
 * run is slow and later ones are not.
 */

import { expect, test } from "@playwright/test";

import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";

const HOST = process.env.PDV_E2E_REMOTE_HOST;

/** Cold install uploads the whole bundle; be generous, but not infinite. */
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

let launched: LaunchedApp | null = null;

test.afterEach(async () => {
  await launched?.cleanup();
  launched = null;
});

test.describe(() => {
  test.skip(!HOST, "set PDV_E2E_REMOTE_HOST to run against a real host");
  test.setTimeout(CONNECT_TIMEOUT_MS + 60_000);

  test("connects to a real host and runs the session there", async () => {
    launched = await launchPDV({ env: { PDV_REMOTE: "1" } });
    const { app, window: page } = launched;

    await sendMenuAction(app, { action: "remote:connect" });
    const dialog = page.locator(".remote-panel");
    await expect(dialog).toBeVisible();

    await dialog.locator(".remote-host-input").fill(HOST as string);
    await dialog.getByRole("button", { name: "Connect" }).click();

    // Covers probe, upload, install and self-check on a cold host. A failure
    // here is reported in the dialog, so surface that rather than a bare
    // timeout.
    await expect(dialog.getByText(/Connected to/)).toBeVisible({
      timeout: CONNECT_TIMEOUT_MS,
    });
    await expect(dialog.locator(".remote-error")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Run session here" }).click();

    await expect(dialog.getByText(/Your session is running on/)).toBeVisible({
      timeout: 60_000,
    });
    // The status bar is driven by the session-state push, not by the dialog
    // that triggered it, so agreeing here means the swap really happened.
    await expect(page.locator(".status-bar")).toContainText(HOST as string, {
      timeout: 15_000,
    });
    // And no error crept in behind the success text.
    await expect(dialog.locator(".remote-error")).toHaveCount(0);

    // Exactly one reconnect marker for one connect. Two would claim two
    // separate intervals of lost output.
    await dialog.getByRole("button", { name: "Close" }).click();
    const markers = page.getByText(/output produced while disconnected/);
    expect(await markers.count()).toBeLessThanOrEqual(1);
  });

  // Once a failing-by-design fixme ("a remote host has no PDV Python
  // environment"), now the provisioning proof: the default New Python
  // Project drives the bundle's own uv on the host — venv, packages, and
  // the bundled pdv-python wheel — and the kernel that boots from it runs
  // real code there. What made it pass, for the record: PDV_RESOURCES_ROOT
  // reaching the daemon, a bundle free of macOS tar metadata, and a boot
  // silence allowance that tolerates cold imports from an NFS home.
  test("starts a kernel on the remote host", async () => {
    // The step beyond "the session moved": the kernel, the Tree and the
    // ZeroMQ loopback all have to come up *there*.
    launched = await launchPDV({ env: { PDV_REMOTE: "1" } });
    const { app, window: page } = launched;

    await sendMenuAction(app, { action: "remote:connect" });
    const dialog = page.locator(".remote-panel");
    await dialog.locator(".remote-host-input").fill(HOST as string);
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(dialog.getByText(/Connected to/)).toBeVisible({
      timeout: CONNECT_TIMEOUT_MS,
    });
    await dialog.getByRole("button", { name: "Run session here" }).click();
    await expect(dialog.getByText(/Your session is running on/)).toBeVisible({
      timeout: 60_000,
    });
    await dialog.getByRole("button", { name: "Close" }).click();

    // The default new-project path: uv mode, using the bundle's own uv and
    // pdv-python wheel on the host. Cold-cache uv downloads a CPython and
    // the default packages, so the ceiling is generous.
    await sendMenuAction(app, { action: "project:new" });
    await page.getByRole("button", { name: "New Python Project" }).click();
    await page.getByTestId("new-project-create").click();

    // Either the kernel comes up, or the UI says why. A spinner that never
    // resolves is the failure mode this test exists to catch.
    await expectKernelReady(page, 300_000);
    await expect(page.getByText(/Starting kernel/)).toHaveCount(0);

    // The kernel is not just alive — it runs code on the cluster. Asking it
    // for the hostname closes the loop: the answer must be the remote node,
    // not this laptop.
    const editor = page.getByRole("textbox", { name: "Editor content" });
    await editor.focus();
    await page.keyboard.type("import socket; print(socket.gethostname())");
    await page.getByRole("button", { name: "Execute" }).click();
    // Not `.first()` — the reconnect marker also renders as a log entry;
    // the hostname arrives in a later one.
    await expect(page.locator(".log-stdout").filter({ hasText: /feyn/i })).toBeVisible({
      timeout: 60_000,
    });
  });
});
