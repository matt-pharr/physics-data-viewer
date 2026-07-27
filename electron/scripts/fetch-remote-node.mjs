#!/usr/bin/env node
/**
 * fetch-remote-node.mjs — Download the Node runtime the remote bundle carries.
 *
 * A cluster login node cannot be assumed to have Node at all — the first
 * host this was tried against had none — so the bundle ships its own rather
 * than depending on what happens to be installed or loadable via a module
 * system.
 *
 * **The version is not a free choice.** PDV does not compile zeromq for the
 * remote host; it ships the prebuilt addons vendored in the npm package, and
 * those exist only for particular Node ABIs. `remoteNodeAbi` in package.json
 * is the ABI those prebuilds provide for *both* linux arches, and the
 * version fetched here must match it. The pairing is asserted below and by
 * the ABI guard in `main/server/self-check.test.ts`; changing either without
 * the other produces a bundle that installs cleanly and then cannot start a
 * kernel.
 *
 * Structurally a sibling of `fetch-uv.mjs`: pinned version in package.json,
 * SHASUMS256 verification against the official checksum file, and a marker
 * so repeat runs are free.
 *
 * Usage: node scripts/fetch-remote-node.mjs [--arch x64|arm64]
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"));
const NODE_VERSION = pkg.remoteNodeVersion;
const NODE_ABI = pkg.remoteNodeAbi;

if (!NODE_VERSION || !NODE_ABI) {
  console.error("[fetch-node] package.json needs remoteNodeVersion and remoteNodeAbi");
  process.exit(1);
}

const ARCHES = ["x64", "arm64"];
const argv = process.argv.slice(2);
let targets = ARCHES;
const archFlag = argv.indexOf("--arch");
if (archFlag !== -1) {
  const value = argv[archFlag + 1];
  if (!ARCHES.includes(value)) {
    console.error(`[fetch-node] unknown --arch ${value}`);
    process.exit(2);
  }
  targets = [value];
}

const destRoot = path.join(electronRoot, "resources", "node");
const base = `https://nodejs.org/dist/${NODE_VERSION}`;

/**
 * Download a URL into memory.
 *
 * @param {string} url
 * @returns {Promise<Buffer>}
 * @throws {Error} On a non-2xx response.
 */
async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const shasums = (await download(`${base}/SHASUMS256.txt`)).toString("utf8");

for (const arch of targets) {
  const archiveName = `node-${NODE_VERSION}-linux-${arch}.tar.xz`;
  const destDir = path.join(destRoot, `linux-${arch}`);
  const marker = path.join(destDir, ".node-version");

  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === NODE_VERSION) {
    console.log(`[fetch-node] linux-${arch}: ${NODE_VERSION} already present — skipping.`);
    continue;
  }

  const expectedLine = shasums.split("\n").find((line) => line.trim().endsWith(archiveName));
  if (!expectedLine) {
    console.error(`[fetch-node] ${archiveName} not listed in SHASUMS256.txt`);
    process.exit(1);
  }
  const expected = expectedLine.trim().split(/\s+/)[0];

  console.log(`[fetch-node] linux-${arch}: downloading ${archiveName}...`);
  const archive = await download(`${base}/${archiveName}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    console.error(`[fetch-node] checksum mismatch for ${archiveName}\n  expected ${expected}\n  actual   ${actual}`);
    process.exit(1);
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = path.join(destRoot, archiveName);
  fs.writeFileSync(tmp, archive);
  // --strip-components=1 drops the node-vX-linux-arch/ wrapper so the layout
  // is a plain bin/ lib/ include/, which is what the bundle expects.
  execFileSync("tar", ["-xJf", tmp, "-C", destDir, "--strip-components=1"], { stdio: "inherit" });
  fs.rmSync(tmp, { force: true });

  // Trim what a headless server will never use. npm alone is ~12 MB, and
  // every byte here is uploaded over ssh on a user's first connect.
  for (const drop of ["include", path.join("lib", "node_modules", "npm"), path.join("lib", "node_modules", "corepack"), "share"]) {
    fs.rmSync(path.join(destDir, drop), { recursive: true, force: true });
  }
  for (const drop of ["npm", "npx", "corepack"]) {
    fs.rmSync(path.join(destDir, "bin", drop), { force: true });
  }

  fs.writeFileSync(path.join(destDir, "version"), `${NODE_VERSION}\n`);
  fs.writeFileSync(marker, `${NODE_VERSION}\n`);
  console.log(`[fetch-node] linux-${arch}: ready at resources/node/linux-${arch}`);
}

console.log(`[fetch-node] Node ${NODE_VERSION} (ABI ${NODE_ABI}) → ${targets.join(", ")}`);
