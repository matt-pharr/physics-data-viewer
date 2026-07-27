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
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";
import { createNewPythonProject } from "./helpers/new-project";

const REPO_ROOT = path.resolve(__dirname, "..");
const FAKE_SSH = path.join(REPO_ROOT, "main", "remote", "__fixtures__", "fake-ssh.cjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "main", "server", "server-main.js");
/** The real app version, read at runtime — the daemon's comm layer enforces it. */
const APP_VERSION = (
  JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** Runtime dirs created per launch; removed in afterEach. */
const runtimeDirs: string[] = [];

/** Env that makes the remote path reachable with no cluster and no real ssh. */
function remoteEnv(): Record<string, string> {
  const runtimeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pdv-rt-"));
  runtimeDirs.push(runtimeDir);
  return {
    PDV_REMOTE: "1",
    // Isolate the session socket per launch. The default runtime dir is
    // shared (`/tmp/pdv-server-<uid>`) and the session id is
    // username-stable, so without this every spec run attaches to whatever
    // daemon a PREVIOUS run leaked — old code, old config, very confusing
    // failures (it happened).
    PDV_SERVER_RUNTIME_DIR: runtimeDir,
    // Executable with a `#!/usr/bin/env node` shebang, so it stands in for
    // the ssh binary directly rather than needing an interpreter prefix.
    PDV_SSH_PATH: FAKE_SSH,
    // The daemon and the attach proxy are the real pdv-server, run through
    // the Electron binary as plain Node exactly as production does. The env
    // contract mirrors the bootstrap-generated command (bootstrap.ts):
    // PDV_APP_VERSION must ride along, or the daemon starts as version
    // "unknown" and the comm router rejects every kernel message.
    PDV_REMOTE_SERVER_COMMAND:
      `PDV_APP_VERSION="${APP_VERSION}" ` +
      `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${SERVER_ENTRY}"`,
    FAKE_SSH_MASTER: "alive",
    FAKE_SSH_EXEC: "local",
  };
}

let launched: LaunchedApp | null = null;

test.afterEach(async () => {
  await launched?.cleanup();
  launched = null;
  for (const dir of runtimeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("connects to a host and moves the session onto it", async () => {
  test.setTimeout(240_000);
  launched = await launchPDV({ env: remoteEnv() });
  const { app, window: page, homeDir } = launched;

  // A per-host setup script configured before connecting — THROUGH THE UI,
  // Settings → Remote Hosts, the same path a user takes. The assertions at
  // the bottom prove the whole chain: editor → saved master copy → shipped
  // to the session dir on the "host" → sourced by the daemon's login-env
  // capture → applied to a kernel a user's code can see. Deliberately NOT a
  // PDV_-prefixed name: that prefix is the daemon's reserved namespace and
  // applyLoginEnv discards it (the first version of this spec fell into
  // exactly that trap, asserting a marker that could never have been
  // applied).
  const setupContent = "export E2E_SETUP_MARKER='shipped and sourced'\n";
  await sendMenuAction(app, { action: "settings:open" });
  await page.getByRole("button", { name: "Remote Hosts" }).click();
  // The temp HOME has no ssh config, so the host list starts empty and the
  // free-typed destination path is what gets exercised.
  const addHost = page.getByPlaceholder("user@host");
  await addHost.fill("testhost");
  await addHost.press("Enter");
  await page.locator(".settings-remote-script").fill(setupContent);
  await page.getByRole("button", { name: "Save testhost" }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Close settings" }).click();

  // Enter through the welcome screen's own button — the primary user path
  // since the four-button welcome landed (the File menu remains an
  // alternative route and is exercised by the other specs).
  await page.getByRole("button", { name: "Connect to Host…" }).click();

  const dialog = page.locator(".remote-panel");
  await expect(dialog).toBeVisible();

  await dialog.locator(".remote-host-input").fill("testhost");
  await dialog.getByRole("button", { name: "Connect" }).click();

  // Connect chains straight into moving the session — no intermediate
  // "Connected, now click Run" step — and the dialog closes itself,
  // landing on the welcome screen. The flipped Disconnect button doubles
  // as the "session is now remote" confirmation.
  await expect(dialog).not.toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Disconnect from ‘testhost’" }),
  ).toBeVisible({ timeout: 30_000 });
  // And the status bar agrees — the renderer learned it from the session
  // state push rather than from the dialog that triggered it.
  await expect(page.locator(".status-bar")).toContainText(/testhost/i, {
    timeout: 10_000,
  });

  // The setup script really shipped: byte-identical in the session dir on
  // the "host" (the temp HOME the fake ssh executes under)...
  const sessionDir = path.join(
    homeDir,
    ".pdv-server",
    "run",
    "sessions",
    `pdv-${os.userInfo().username}`,
  );
  expect(await fs.readFile(path.join(sessionDir, "setup.sh"), "utf8")).toBe(setupContent);
  // ...and the daemon really sourced it: this log suffix is derived from a
  // sentinel the capture shell exports after the `.` line — evidence from
  // inside the capture, not a stat of the file. Written before the socket
  // binds, so reaching "running on" above guarantees it is on disk.
  const daemonLog = await fs.readFile(path.join(sessionDir, "session.log"), "utf8");
  expect(daemonLog).toMatch(/applied login environment .*setup script sourced/);
  // session.json records the same verdict for later diagnostics.
  const meta = JSON.parse(
    await fs.readFile(path.join(sessionDir, "session.json"), "utf8"),
  ) as { setupScriptApplied?: boolean };
  expect(meta.setupScriptApplied).toBe(true);

  // Finally, the part a user actually cares about: a kernel started in this
  // session sees the variable. This closes the gap none of the file/log
  // assertions can — that the captured environment was APPLIED to
  // process.env and inherited by the kernel spawn. (The dialog already
  // auto-closed on success; the welcome with the flipped button was
  // asserted above.)
  await createNewPythonProject(page);
  // Remote path provisions a uv env before the kernel boots; generous but
  // bounded (uv download cache is shared across specs).
  await expectKernelReady(page, 150_000);
  const editor = page.getByRole("textbox", { name: "Editor content" });
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press("Backspace");
  await page.keyboard.type(
    "import os; print('marker=' + os.environ.get('E2E_SETUP_MARKER', 'MISSING'))",
  );
  await page.getByRole("button", { name: "Execute" }).click();
  // Not `.first()`: the session-move console marker ("── session moved to
  // testhost ──") occupies the first stdout slot. Filter to the marker line
  // so a "marker=MISSING" result still fails with the actual value shown.
  await expect(
    page.locator(".log-stdout").filter({ hasText: "marker=" }).first(),
  ).toContainText("marker=shipped and sourced", { timeout: 30_000 });
});

test("welcome Disconnect returns the window to a local session", async () => {
  // The full return trip the connect spec's label assertion cannot see:
  // click the welcome screen's Disconnect, and the window lands back on a
  // fresh local session while the daemon keeps running on the "host".
  launched = await launchPDV({ env: remoteEnv() });
  const { window: page } = launched;

  await page.getByRole("button", { name: "Connect to Host…" }).click();
  const dialog = page.locator(".remote-panel");
  await dialog.locator(".remote-host-input").fill("testhost");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Disconnect from ‘testhost’" }).click();

  // Back on a local session: the button flips back and the status bar no
  // longer names the host.
  await expect(page.getByRole("button", { name: "Connect to Host…" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".status-bar")).not.toContainText(/testhost/i);
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
    dialog.getByRole("button", { name: /Run session on/ }),
  ).toHaveCount(0);

  await dialog.getByRole("button", { name: "Close" }).click();
  // The app is still usable: the local session was never touched.
  await expect(page.locator(".welcome-overlay")).toBeVisible();
});

test("surfaces a remote kernel-start failure instead of spinning", async () => {
  test.setTimeout(240_000);
  // The failure mode this pins down was found on a real cluster: a host
  // where the session environment cannot be built. The invariant is that
  // the failure is LOUD — the launch overlay lands on "Session failed to
  // start" with the daemon's actual error and a Retry — never an unbounded
  // "Starting kernel…" spinner. The daemon-side failure is forced
  // deterministically: a fresh remote config whose default packages cannot
  // resolve, so the uv sync step fails fast on the host.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-remote-fail-"));
  const remotePdvDir = path.join(scratch, "dot-pdv");
  await fs.mkdir(remotePdvDir, { recursive: true });
  await fs.writeFile(
    path.join(remotePdvDir, "preferences.json"),
    JSON.stringify({ defaultPackages: ["pdv-does-not-exist-anywhere-e2e"] }),
    "utf8",
  );

  launched = await launchPDV({
    env: {
      ...remoteEnv(),
      PDV_REMOTE_SERVER_COMMAND:
        `PDV_APP_VERSION="${APP_VERSION}" PDV_PDV_DIR="${remotePdvDir}" ` +
        `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${SERVER_ENTRY}"`,
    },
  });
  const { app, window: page } = launched;

  await sendMenuAction(app, { action: "remote:connect" });
  const dialog = page.locator(".remote-panel");
  await dialog.locator(".remote-host-input").fill("testhost");
  await dialog.getByRole("button", { name: "Connect" }).click();
  // Connect chains into the session move and auto-closes; wait for the
  // swap to be reflected on the welcome before driving the new-project
  // flow against the host.
  await expect(dialog).not.toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Disconnect from ‘testhost’" }),
  ).toBeVisible({ timeout: 30_000 });

  // The default new-project path (uv mode) against the poisoned config.
  await sendMenuAction(app, { action: "project:new" });
  await page.getByRole("button", { name: "New Python Project" }).click();
  await page.getByTestId("new-project-create").click();

  try {
    // The overlay must land on the failed state with the daemon's error and
    // a way out — not spin forever.
    await expect(page.locator(".env-sync-title")).toHaveText(
      "Session failed to start",
      { timeout: 120_000 },
    );
    await expect(page.locator(".env-sync-error")).toContainText(
      /uv environment setup failed/,
    );
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("does not offer remote mode unless it is enabled", async () => {
  // The entry stays gated while remote mode is finished off; the picker
  // has landed, so the gate is now a release toggle rather than a
  // correctness requirement.
  launched = await launchPDV({ env: { PDV_REMOTE: "0" } });
  const { app, window: page } = launched;

  const hasEntry = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return menu?.getMenuItemById("remote:connect") != null;
  });

  expect(hasEntry).toBe(false);
  // The welcome screen's Connect to Host button honors the same gate.
  await expect(page.locator(".welcome-overlay")).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect to Host/ })).toHaveCount(0);
  // And so does the Settings → Remote Hosts tab.
  await sendMenuAction(app, { action: "settings:open" });
  await expect(page.getByRole("button", { name: "Close settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remote Hosts" })).toHaveCount(0);
});
