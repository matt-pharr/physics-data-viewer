#!/usr/bin/env node
/**
 * fetch-uv.mjs — Download the pinned `uv` binary for PDV's packaging targets.
 *
 * Reads the pinned version from electron/package.json ("uvVersion"), downloads
 * the matching uv release archive from the astral-sh/uv GitHub releases,
 * verifies its published SHA-256 checksum, and extracts the `uv` executable to
 *   electron/resources/uv/<platform>-<arch>/uv[.exe]
 *
 * electron-builder bundles the per-platform binary into the app resources
 * (see the mac/linux `extraResources` in electron-builder.yml). At runtime,
 * uv-runner.ts resolves it.
 *
 * Usage:
 *   node scripts/fetch-uv.mjs           # host-OS packaging targets + host + linux remote (default)
 *   node scripts/fetch-uv.mjs --host    # fetch only the host platform (dev)
 *   node scripts/fetch-uv.mjs --all     # fetch every known target
 *
 * Idempotent: a target whose binary already matches the pinned version is
 * skipped. Wired into the `prebuild` npm script.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(electronRoot, "package.json"), "utf8")
);
const UV_VERSION = pkg.uvVersion;

if (!UV_VERSION) {
  console.error('[fetch-uv] No "uvVersion" field in electron/package.json.');
  process.exit(1);
}

/** Packaging target (`<platform>-<arch>`) → uv release target triple. */
const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** Targets fetched by default — keep in sync with electron-builder.yml. */
const PACKAGED_TARGETS = ["darwin-arm64", "linux-x64"];

/**
 * Targets the remote server bundle ships (build-server-bundle.mjs). Remote
 * hosts are always linux, whatever OS the app is built on, and the remote
 * server has no PATH fallback for uv — a bundle without one cannot start a
 * Python kernel on a fresh host. Both arches, matching the Node runtimes
 * fetch-remote-node.mjs provides.
 */
const REMOTE_TARGETS = ["linux-x64", "linux-arm64"];

/**
 * Decide which targets to fetch from the CLI flags.
 *
 * The default set is the packaged targets for the host OS (electron-builder
 * only packages for the OS it runs on), the host itself, so `npm run build`
 * on any supported OS leaves a uv that dev mode and build-pdv-wheel.mjs can
 * actually execute, and the linux {@link REMOTE_TARGETS} for the remote
 * server bundle.
 *
 * @returns Array of platform keys.
 */
function selectTargets() {
  const args = process.argv.slice(2);
  if (args.includes("--all")) {
    return Object.keys(TARGETS);
  }
  const hostKey = `${process.platform}-${process.arch}`;
  if (args.includes("--host")) {
    if (!TARGETS[hostKey]) {
      console.error(`[fetch-uv] Unsupported host platform: ${hostKey}`);
      process.exit(1);
    }
    return [hostKey];
  }
  const targets = PACKAGED_TARGETS.filter((key) =>
    key.startsWith(`${process.platform}-`)
  );
  if (TARGETS[hostKey]) targets.push(hostKey);
  targets.push(...REMOTE_TARGETS);
  return [...new Set(targets)];
}

/**
 * Extract a `.zip` or `.tar.gz` archive into a directory.
 *
 * On a Windows build host both formats go through the bsdtar that ships as
 * `System32\tar.exe` (Windows 10 1803+). The absolute path matters: a
 * Git-for-Windows or MSYS `tar` earlier on PATH is GNU tar, which cannot
 * read zip and treats the `C:` in a Windows path as a remote host — and the
 * linux tarball is fetched on Windows too, for the remote server bundle.
 *
 * @param {string} archivePath - The archive file.
 * @param {string} destDir - Directory to extract into.
 * @returns {void}
 */
function extractArchive(archivePath, destDir) {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const tar = path.join(systemRoot, "System32", "tar.exe");
    execFileSync(tar, ["-xf", archivePath, "-C", destDir], { stdio: "inherit" });
  } else if (archivePath.endsWith(".zip")) {
    execFileSync("unzip", ["-o", archivePath, "-d", destDir], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
  }
}

/**
 * Download a URL to a Buffer, following redirects.
 *
 * @param {string} url - URL to fetch.
 * @returns {Promise<Buffer>} The response body.
 */
async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch, verify, and install the uv binary for one packaging target.
 *
 * @param {string} platformKey - A key of {@link TARGETS}.
 * @returns {Promise<void>}
 */
async function fetchTarget(platformKey) {
  const triple = TARGETS[platformKey];
  const isWindows = platformKey.startsWith("win32");
  const exe = isWindows ? "uv.exe" : "uv";
  const destDir = path.join(electronRoot, "resources", "uv", platformKey);
  const destBinary = path.join(destDir, exe);
  const marker = path.join(destDir, ".uv-version");

  if (
    fs.existsSync(destBinary) &&
    fs.existsSync(marker) &&
    fs.readFileSync(marker, "utf8").trim() === UV_VERSION
  ) {
    console.log(
      `[fetch-uv] ${platformKey}: uv ${UV_VERSION} already present — skipping.`
    );
    return;
  }

  const archiveName = `uv-${triple}.${isWindows ? "zip" : "tar.gz"}`;
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  console.log(
    `[fetch-uv] ${platformKey}: downloading uv ${UV_VERSION} (${archiveName})...`
  );

  const [archive, shaText] = await Promise.all([
    download(`${base}/${archiveName}`),
    download(`${base}/${archiveName}.sha256`).then((b) => b.toString("utf8")),
  ]);

  const expected = shaText.trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-fetch-uv-"));
  try {
    const archivePath = path.join(tmp, archiveName);
    fs.writeFileSync(archivePath, archive);
    extractArchive(archivePath, tmp);
    // uv archives extract either to `uv-<triple>/uv[.exe]` or, for some
    // release layouts, to `uv[.exe]` at the archive root.
    const candidates = [
      path.join(tmp, `uv-${triple}`, exe),
      path.join(tmp, exe),
    ];
    const extracted = candidates.find((c) => fs.existsSync(c));
    if (!extracted) {
      throw new Error(`extracted archive has no ${exe}`);
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(extracted, destBinary);
    if (!isWindows) {
      fs.chmodSync(destBinary, 0o755);
    }
    fs.writeFileSync(marker, `${UV_VERSION}\n`, "utf8");
    console.log(
      `[fetch-uv] ${platformKey}: installed → ${path.relative(electronRoot, destBinary)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const targets = selectTargets();
console.log(`[fetch-uv] uv ${UV_VERSION} → targets: ${targets.join(", ")}`);

let failed = false;
for (const target of targets) {
  try {
    await fetchTarget(target);
  } catch (err) {
    failed = true;
    console.error(`[fetch-uv] ${target}: FAILED — ${err.message}`);
  }
}
if (failed) {
  process.exit(1);
}
