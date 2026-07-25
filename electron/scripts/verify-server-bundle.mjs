#!/usr/bin/env node
/**
 * verify-server-bundle.mjs — Smoke-test the shipped pdv-server bundle.
 *
 * Runs `dist/server-bundle/pdv-server.cjs` — the exact artifact
 * electron-builder copies into `<Resources>/pdv-server/` — under plain Node
 * and drives the reserved transport handshake: hello push, `pdv.rpc.ping`,
 * `pdv.rpc.shutdown`, clean exit 0.
 *
 * Why this exists: `server-loopback.test.ts` bundles from the TypeScript
 * source (it must run in the unit-test job, which never builds `dist/`), and
 * the Playwright suite runs unpackaged against the tsc output. So without
 * this, the tsc → esbuild → single-.cjs artifact that actually ships was
 * never executed by anything except a manual packaged smoke test on one
 * platform. Wired into CI's build job, which already produces the bundle.
 *
 * Deliberately does NOT start a kernel: no Python/ZeroMQ is assumed. This
 * checks that the bundle loads, wires a session, and speaks the protocol —
 * the failure mode a bundling mistake produces (a missing dependency, a
 * broken `require` after inlining, a stdout write corrupting frame one).
 *
 * Exits 0 on success, 1 with a diagnostic otherwise.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, "..");
const bundle = path.join(electronRoot, "dist", "server-bundle", "pdv-server.cjs");

if (!fs.existsSync(bundle)) {
  console.error(
    "[verify-server-bundle] dist/server-bundle/pdv-server.cjs not found — run `npm run build:server` first.",
  );
  process.exit(1);
}

const { version } = JSON.parse(
  fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"),
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-verify-bundle-"));

/** Best-effort cleanup of the throwaway HOME-ish dirs. */
function cleanup() {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const child = spawn(process.execPath, [bundle, "serve", "--stdio"], {
  env: {
    ...process.env,
    PDV_APP_VERSION: version,
    PDV_USER_DATA_DIR: path.join(tmp, "userData"),
    PDV_PDV_DIR: path.join(tmp, "pdv"),
    // The bundle externalizes zeromq; point it at the repo's copy the way
    // the packaged supervisor points at the asar-unpacked one.
    PDV_ZEROMQ_PATH: path.join(electronRoot, "node_modules", "zeromq"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
let sawHello = false;
let sawPing = false;
/** Non-protocol stdout lines: these would corrupt real frames. */
const junkLines = [];

const timer = setTimeout(() => {
  console.error(
    `[verify-server-bundle] timed out (hello=${sawHello} ping=${sawPing})`,
  );
  child.kill("SIGKILL");
  cleanup();
  process.exit(1);
}, 60_000);

function send(id, channel) {
  child.stdin.write(`${JSON.stringify({ id, channel, args: [] })}\n`);
}

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      junkLines.push(line.slice(0, 200));
      continue;
    }
    if (msg.event === "pdv.rpc.hello") {
      if (msg.payload?.version !== version) {
        console.error(
          `[verify-server-bundle] hello version ${msg.payload?.version} != ${version}`,
        );
        child.kill("SIGKILL");
        cleanup();
        process.exit(1);
      }
      sawHello = true;
      send("1", "pdv.rpc.ping");
    } else if (msg.id === "1") {
      sawPing = true;
      send("2", "pdv.rpc.shutdown");
    }
  }
});

// Relayed for diagnostics only — the server logs to stderr by design.
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[pdv-server] ${chunk}`);
});

child.on("error", (err) => {
  clearTimeout(timer);
  console.error(`[verify-server-bundle] spawn failed: ${err.message}`);
  cleanup();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  cleanup();
  const problems = [];
  if (!sawHello) problems.push("no hello push");
  if (!sawPing) problems.push("no ping response");
  if (code !== 0) problems.push(`exit code ${code} (signal ${signal})`);
  // Anything unparseable on stdout means something bypassed the
  // console→stderr rebind and would corrupt the RPC framing.
  if (junkLines.length > 0) {
    problems.push(`${junkLines.length} non-protocol stdout line(s): ${junkLines[0]}`);
  }
  if (problems.length > 0) {
    console.error(`[verify-server-bundle] FAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log(
    `[verify-server-bundle] OK — bundle handshakes and shuts down cleanly (version ${version})`,
  );
});
