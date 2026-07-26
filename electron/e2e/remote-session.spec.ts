/**
 * remote-session.spec.ts — the remote path, end to end, without a cluster.
 *
 * Drives the real UI: File-menu action → connect dialog → connect → "Run
 * session here" → the session swaps onto a daemon, and the status bar says
 * so. Every layer under the dialog is the production one. Only two things
 * are substituted, both via env seams the app ignores in a normal run:
 *
 *  - `PDV_SSH_PATH` points at `fake-ssh.cjs`, which really parses ssh's
 *    arguments and really executes the remote command under `/bin/sh` with
 *    its stdio inherited — so the RPC stream is a genuine duplex pipe into a
 *    genuine `pdv-server attach`.
 *  - `PDV_REMOTE_SERVER_COMMAND` supplies the server directly, standing in
 *    for a bundle installed on a host.
 *
 * This exists because the remote path had no automated coverage at all and
 * three bugs shipped that a human found by hand. What this spec covers is
 * the *flow*: that the menu action, dialog, connect, swap and status bar
 * agree, and that a failed connect leaves the local session intact.
 *
 * What it deliberately does NOT cover, stated so nobody assumes otherwise:
 * the argument-shape bugs (an unquoted `ControlPath`, and a `sun_path`
 * budget that ignored the temporary socket ssh really binds) are invisible
 * here, because the control path resolves to the temp dir on this machine
 * and so never contains a space. Those live in `ssh-mux.test.ts`, where the
 * path can be chosen deliberately and `fake-ssh` reproduces ssh's own
 * parsing of `-o` values. I checked that by mutation rather than assuming
 * it: removing the quoting leaves this spec green and fails those.
 */

import { expect, test } from "@playwright/test";
import * as path from "path";

import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";

const REPO_ROOT = path.resolve(__dirname, "..");
const FAKE_SSH = path.join(REPO_ROOT, "main", "remote", "__fixtures__", "fake-ssh.cjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "main", "server", "server-main.js");

/** Env that makes the remote path reachable with no cluster and no real ssh. */
function remoteEnv(): Record<string, string> {
  return {
    PDV_REMOTE: "1",
    // Executable with a `#!/usr/bin/env node` shebang, so it stands in for
    // the ssh binary directly rather than needing an interpreter prefix.
    PDV_SSH_PATH: FAKE_SSH,
    // The daemon and the attach proxy are the real pdv-server, run through
    // the Electron binary as plain Node exactly as production does.
    PDV_REMOTE_SERVER_COMMAND: `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${SERVER_ENTRY}"`,
    FAKE_SSH_MASTER: "alive",
    FAKE_SSH_EXEC: "local",
  };
}

let launched: LaunchedApp | null = null;

test.afterEach(async () => {
  await launched?.cleanup();
  launched = null;
});

test("connects to a host and moves the session onto it", async () => {
  launched = await launchPDV({ env: remoteEnv() });
  const { app, window: page } = launched;

  await sendMenuAction(app, { action: "remote:connect" });

  const dialog = page.locator(".remote-panel");
  await expect(dialog).toBeVisible();

  await dialog.locator(".remote-host-input").fill("testhost");
  await dialog.getByRole("button", { name: "Connect" }).click();

  // The connect itself must succeed before anything can be run on the host.
  await expect(dialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 });

  await dialog.getByRole("button", { name: "Run session here" }).click();

  // The session is now served by a daemon reached over the (fake) channel.
  await expect(dialog.getByText(/Your session is running on/)).toBeVisible({
    timeout: 30_000,
  });
  // And the status bar agrees — the renderer learned it from the session
  // state push rather than from the dialog that triggered it.
  await expect(page.locator(".status-bar")).toContainText(/testhost/i, {
    timeout: 10_000,
  });
});

test("keeps the local session working when the host cannot be reached", async () => {
  // The failure that matters most: a user who cannot connect must be left
  // with the session they already had, not with neither.
  launched = await launchPDV({
    env: { ...remoteEnv(), FAKE_SSH_MASTER: "refused", FAKE_SSH_AUTH: "fail" },
  });
  const { app, window: page } = launched;

  await sendMenuAction(app, { action: "remote:connect" });
  const dialog = page.locator(".remote-panel");
  await dialog.locator(".remote-host-input").fill("testhost");
  await dialog.getByRole("button", { name: "Connect" }).click();

  await expect(dialog.locator(".remote-error")).toBeVisible({ timeout: 30_000 });
  // No "Run session here" is offered, because there is nothing to run on.
  await expect(
    dialog.getByRole("button", { name: "Run session here" }),
  ).toHaveCount(0);

  await dialog.getByRole("button", { name: "Close" }).click();
  // The app is still usable: the local session was never touched.
  await expect(page.locator(".welcome-overlay")).toBeVisible();
});

test("does not offer remote mode unless it is enabled", async () => {
  // The entry is hidden until the remote path picker lands, because every
  // server-side file dialog is still native and would browse the laptop
  // while the session runs on the cluster.
  launched = await launchPDV({ env: { PDV_REMOTE: "0" } });
  const { app } = launched;

  const hasEntry = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return menu?.getMenuItemById("remote:connect") != null;
  });

  expect(hasEntry).toBe(false);
});
