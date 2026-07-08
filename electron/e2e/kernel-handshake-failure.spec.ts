/**
 * kernel-handshake-failure.spec.ts — Drives the cold-start failure path.
 *
 * Regression test for #222: when the kernel-side bootstrap raises, the user
 * should see a multi-line diagnostic (step name, process state, kernel
 * status, last iopub msg_type) in the env-settings dialog instead of a
 * black-box "Kernel failed to start" message.
 *
 * Mechanism: prepend a temp dir to PYTHONPATH that contains a fake `pdv`
 * package whose `bootstrap()` raises. Both the env-check probe and the
 * spawned kernel subprocess inherit PYTHONPATH from Electron's process.env,
 * so the fake shadows the real package without touching the user's
 * site-packages.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { createNewPythonProject } from "./helpers/new-project";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPackage = require("../package.json") as { version: string };

const FORCED_FAILURE_MARKER = "forced E2E failure for diagnostic test";

let launched: LaunchedApp;
let shimDir: string;

test.beforeAll(async () => {
  shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-pdv-shim-"));
  const pkgDir = path.join(shimDir, "pdv");
  await fs.mkdir(pkgDir, { recursive: true });

  // The fake must satisfy the bootstrap code in kernel-session.ts:
  //   import pdv;  from pdv import PDVTree;  import pdv.comms as _pdv_comms;
  //   pdv.bootstrap(_ip)  ← raises here
  // …and the env-check probe (`python -c "import pdv; print(pdv.__version__)"`),
  // which requires `__version__` to match the running app version exactly
  // (during 0.x). PDVTree just needs to be importable; comms.py is never
  // touched after bootstrap throws.
  await fs.writeFile(
    path.join(pkgDir, "__init__.py"),
    [
      `__version__ = ${JSON.stringify(electronPackage.version)}`,
      "",
      "class PDVTree(dict):",
      "    pass",
      "",
      "def bootstrap(ip=None):",
      `    raise RuntimeError(${JSON.stringify(FORCED_FAILURE_MARKER)})`,
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(pkgDir, "comms.py"), "", "utf8");

  const existingPyPath = process.env.PYTHONPATH;
  const pythonPath = existingPyPath
    ? `${shimDir}${path.delimiter}${existingPyPath}`
    : shimDir;

  launched = await launchPDV({
    env: { PYTHONPATH: pythonPath },
  });
});

test.afterAll(async () => {
  await launched?.cleanup();
  if (shimDir) {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test("bootstrap failure surfaces the multi-line diagnostic in the env-settings dialog", async () => {
  const { window } = launched;
  await createNewPythonProject(window);

  // New Python Project boots a uv-mode kernel, so a bootstrap-step handshake
  // failure now routes through launchUvKernel → setUvSync({phase:"failed"}),
  // which renders the diagnostic in the EnvSyncModal's `.env-sync-error`
  // slot (white-space: pre-wrap preserves the multi-line layout).
  const warning = window.locator(".env-sync-error").filter({
    hasText: /Kernel handshake failed at step/,
  });
  await expect(warning).toBeVisible({ timeout: 60_000 });

  const text = await warning.textContent();
  expect(text).toBeTruthy();

  // Header line: step name + the original RuntimeError message.
  expect(text!).toMatch(/Kernel handshake failed at step '(bootstrap|ready|init)':/);
  expect(text!).toContain(FORCED_FAILURE_MARKER);

  // Diagnostic body — three labeled fields.
  expect(text!).toMatch(/process: exitCode=\S+ killed=(true|false)/);
  expect(text!).toMatch(/kernel status: \S+/);
  expect(text!).toMatch(/last iopub msg_type: \S+/);
});
