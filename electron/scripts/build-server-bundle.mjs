#!/usr/bin/env node
/**
 * build-server-bundle.mjs — Assemble the per-arch linux tarball that a
 * remote host installs into `~/.pdv-server/<version>/`.
 *
 * The remote server is the *same* code as the local one — it comes from
 * `lib/bundle-server.mjs`, so local and remote sessions can never silently
 * run different builds under the same version number. What differs is
 * everything around it, because on a cluster there is no Electron, no
 * `<Resources>` directory, and nothing may be assumed present:
 *
 * - **zeromq's linux prebuild**, plus `cmake-ts` and `node-addon-api`, which
 *   are on its runtime `require` path. Nothing is compiled: the prebuilt
 *   addons are already vendored in the npm package. That is also why the
 *   remote Node major is pinned — see the ABI guard in `self-check.test.ts`.
 * - **The assets `getResourcesRoot()` resolves locally**: the pdv-python
 *   wheel and source, pdv-julia source, example modules, and the linux `uv`
 *   binary. Without these a remote host cannot install the kernel package at
 *   all, which would make the whole session useless on arrival.
 *
 * Every payload is optional and reported. A tarball missing `uv` is still
 * useful for a host with a working interpreter, and failing the build
 * because an unrelated asset was not fetched would be obstructive — but
 * shipping one *silently* would strand the user later, so each omission is
 * printed and recorded in the manifest.
 *
 * Output: `dist/remote-bundles/pdv-server-<version>-linux-<arch>.tar.gz`
 * plus an `index.json` carrying each tarball's sha256 and size, which is
 * what the installer verifies against before unpacking.
 *
 * Usage:
 *   node scripts/build-server-bundle.mjs [--arch x64|arm64] [--node <dir>]
 *
 * `--node` points at a directory holding an extracted linux Node runtime for
 * that arch. Without it the tarball carries no interpreter and the manifest
 * says so; the host must then already have a compatible Node.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

import { bundleServer } from "./lib/bundle-server.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(electronRoot, "..");

const ARCHES = ["x64", "arm64"];

/** Parse `--flag value` arguments. */
function parseArgs(argv) {
  const out = { arches: ARCHES, nodeDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arch") {
      const value = argv[++i];
      if (!ARCHES.includes(value)) {
        console.error(`[bundle] unknown --arch ${value} (expected ${ARCHES.join(" or ")})`);
        process.exit(2);
      }
      out.arches = [value];
    } else if (argv[i] === "--node") {
      out.nodeDir = path.resolve(argv[++i]);
    }
  }
  return out;
}

/** Recursively copy a directory or file, creating parents. */
function copyInto(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true, dereference: true });
}

/**
 * Payloads to carry beside the server bundle.
 *
 * `required` marks the ones without which the tarball cannot serve a session
 * at all; the rest degrade a remote install rather than breaking it.
 */
function payloads(arch) {
  const zeromqRoot = path.join(electronRoot, "node_modules", "zeromq");
  return [
    {
      name: "zeromq (linux prebuild)",
      from: path.join(zeromqRoot, "build", "linux", arch),
      to: path.join("node_modules", "zeromq", "build", "linux", arch),
      required: true,
    },
    { name: "zeromq (js)", from: path.join(zeromqRoot, "lib"), to: path.join("node_modules", "zeromq", "lib"), required: true },
    {
      name: "zeromq (package.json)",
      from: path.join(zeromqRoot, "package.json"),
      to: path.join("node_modules", "zeromq", "package.json"),
      required: true,
    },
    // On zeromq's runtime require path: lib/load-addon.js pulls in the
    // cmake-ts loader, which is what picks the right prebuild for the host.
    {
      name: "cmake-ts",
      from: path.join(electronRoot, "node_modules", "cmake-ts"),
      to: path.join("node_modules", "cmake-ts"),
      required: true,
    },
    {
      name: "node-addon-api",
      from: path.join(zeromqRoot, "node_modules", "node-addon-api"),
      to: path.join("node_modules", "zeromq", "node_modules", "node-addon-api"),
      required: false,
    },
    // Assets getResourcesRoot() provides locally. Without the wheel or the
    // source, a remote host cannot install pdv-python and the session is
    // dead on arrival.
    { name: "pdv-python wheel", from: path.join(electronRoot, "resources", "pdv-python-wheel"), to: path.join("resources", "pdv-python-wheel"), required: false },
    { name: "pdv-python source", from: path.join(repoRoot, "pdv-python"), to: path.join("resources", "pdv-python"), required: false, exclude: true },
    { name: "pdv-julia source", from: path.join(repoRoot, "pdv-julia"), to: path.join("resources", "pdv-julia"), required: false, exclude: true },
    { name: "example modules", from: path.join(repoRoot, "examples", "modules"), to: path.join("resources", "examples", "modules"), required: false },
    { name: "uv (linux)", from: path.join(electronRoot, "resources", "uv", `linux-${arch}`), to: path.join("resources", "uv"), required: false },
  ];
}

/** Directory names never worth shipping to a cluster. */
const PRUNE = new Set([
  "__pycache__", ".venv", "build", ".git", ".pytest_cache", ".ruff_cache",
  "tests", "test", "node_modules", ".mypy_cache",
]);

/** Remove development droppings from a copied source tree. */
function prune(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE.has(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        prune(full);
      }
    } else if (entry.name.endsWith(".pyc") || entry.name.endsWith(".egg-info")) {
      fs.rmSync(full, { force: true });
    }
  }
}

/** Total size of a tree, in bytes. */
function treeSize(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(root);
  return total;
}

/**
 * Write a zeromq build manifest containing only this arch's linux prebuilds.
 *
 * The cmake-ts loader reads `build/manifest.json` to learn which addons
 * exist; without it, `require("zeromq")` fails with "Manifest file not
 * found" no matter how many `.node` files are present. Found the hard way —
 * the first bundle installed cleanly on a real host and then could not load
 * zeromq at all.
 *
 * It is filtered rather than copied so the bundle never advertises an addon
 * it does not carry: the loader walks candidates newest-ABI-first and
 * `require`s until one succeeds, and entries pointing at absent files are
 * just failed attempts on a host that has no way to fix them.
 *
 * @param {string} stage - Staging directory root.
 * @param {string} arch - Target architecture.
 * @returns {number} How many prebuild entries were kept.
 */
function writeZeromqManifest(stage, arch) {
  const source = path.join(electronRoot, "node_modules", "zeromq", "build", "manifest.json");
  const full = JSON.parse(fs.readFileSync(source, "utf8"));
  const kept = {};
  for (const [key, target] of Object.entries(full)) {
    let config;
    try {
      config = JSON.parse(key);
    } catch {
      continue;
    }
    if (config.os !== "linux" || config.arch !== arch) continue;
    const addon = path.join(electronRoot, "node_modules", "zeromq", "build", target);
    if (!fs.existsSync(addon)) continue;
    kept[key] = target;
  }
  if (Object.keys(kept).length === 0) {
    console.error(`[bundle] ${arch}: no linux prebuilds found in zeromq's manifest`);
    process.exit(1);
  }
  const dest = path.join(stage, "node_modules", "zeromq", "build", "manifest.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(kept));
  return Object.keys(kept).length;
}

const { arches, nodeDir } = parseArgs(process.argv.slice(2));

const { version } = JSON.parse(fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"));
if (!version) {
  console.error("[bundle] package.json has no version");
  process.exit(1);
}

/**
 * Where `scripts/fetch-remote-node.mjs` leaves a runtime for this arch.
 *
 * @param {string} root - The electron/ directory.
 * @param {string} arch - Target architecture ("x64" | "arm64").
 * @returns {string|null} The directory, or null when it has not been fetched.
 */
function defaultNodeDir(root, arch) {
  const candidate = path.join(root, "resources", "node", `linux-${arch}`);
  return fs.existsSync(candidate) ? candidate : null;
}

const outRoot = path.join(electronRoot, "dist", "remote-bundles");
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const index = { version, generated: null, bundles: [] };

for (const arch of arches) {
  const stage = path.join(outRoot, `.stage-${arch}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // The server itself — same builder the local packaged bundle uses.
  const bytes = await bundleServer({
    entry: path.join(electronRoot, "dist", "main", "server", "server-main.js"),
    outfile: path.join(stage, "pdv-server.cjs"),
    version,
    clean: false,
  });
  console.log(`[bundle] ${arch}: pdv-server.cjs ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  const missing = [];
  writeZeromqManifest(stage, arch);

  for (const payload of payloads(arch)) {
    if (!fs.existsSync(payload.from)) {
      missing.push(payload.name);
      if (payload.required) {
        console.error(`[bundle] ${arch}: MISSING REQUIRED ${payload.name} (${payload.from})`);
        process.exit(1);
      }
      continue;
    }
    const dest = path.join(stage, payload.to);
    copyInto(payload.from, dest);
    if (payload.exclude) prune(dest);
  }

  // Default to where `npm run fetch:remote-node` puts it. Without this the
  // two scripts do not connect, and `npm run build:server-bundle` on its own
  // produces a bundle with no Node in it — which installs fine and then
  // cannot execute anything, reported only as a parenthetical "(omitted)".
  const resolvedNodeDir =
    nodeDir ?? defaultNodeDir(electronRoot, arch);

  let nodeVersion = null;
  if (resolvedNodeDir) {
    if (!fs.existsSync(resolvedNodeDir)) {
      console.error(`[bundle] --node ${resolvedNodeDir} does not exist`);
      process.exit(1);
    }
    copyInto(resolvedNodeDir, path.join(stage, "node"));
    const nodeBin = path.join(stage, "node", "bin", "node");
    if (fs.existsSync(nodeBin)) fs.chmodSync(nodeBin, 0o755);
    nodeVersion = fs.existsSync(path.join(resolvedNodeDir, "version"))
      ? fs.readFileSync(path.join(resolvedNodeDir, "version"), "utf8").trim()
      : "unknown";
  } else {
    missing.push("node runtime");
    // Louder than the parenthetical summary: this bundle will upload,
    // install and verify its checksum, then fail to execute anything at all.
    console.warn(
      `[bundle] WARNING: ${arch} bundle has no Node runtime and cannot run on a host. ` +
        "Run `npm run fetch:remote-node` first.",
    );
  }

  // Read by the installer before it trusts anything in here.
  const manifest = {
    pdv: "server-bundle",
    version,
    platform: "linux",
    arch,
    nodeVersion,
    entry: "pdv-server.cjs",
    zeromqPath: `node_modules/zeromq`,
    omitted: missing,
    uncompressedBytes: treeSize(stage),
  };
  fs.writeFileSync(path.join(stage, "bundle-manifest.json"), JSON.stringify(manifest, null, 2));

  const tarball = path.join(outRoot, `pdv-server-${version}-linux-${arch}.tar.gz`);
  // COPYFILE_DISABLE stops macOS bsdtar from writing AppleDouble ("._*")
  // metadata entries; extracted on a Linux host those become real junk files
  // that shadow real assets (a "._*.whl" broke the wheel install on a real
  // cluster). Harmless elsewhere — GNU tar ignores the variable.
  // macOS metadata must not reach a Linux host, in any of its three forms:
  // --exclude catches real junk files sitting in the source tree (.DS_Store
  // in resources/examples was really there); COPYFILE_DISABLE stops bsdtar
  // from inventing AppleDouble "._*" entries (a "._*.whl" shadowed the real
  // wheel and broke the install on a real cluster); --no-xattrs stops xattr
  // pax headers (com.apple.provenance), which made the host's GNU tar print
  // an "Ignoring unknown extended header" warning per file — thousands of
  // lines of red noise streamed into the connect dialog.
  execFileSync(
    "tar",
    [
      "-czf", tarball,
      "--no-xattrs",
      "--exclude", "._*",
      "--exclude", ".DS_Store",
      "-C", stage, ".",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  // Verify rather than trust: a tar that ignores these options would
  // regress silently, and every form only bites on the Linux host.
  const junk = execFileSync("tar", ["-tzf", tarball])
    .toString()
    .split("\n")
    .filter((entry) => /(^|\/)\._|(^|\/)\.DS_Store/.test(entry));
  if (junk.length > 0) {
    throw new Error(
      `[bundle] macOS metadata junk in ${path.basename(tarball)} ` +
        `(would shadow real assets on the host): ${junk.slice(0, 5).join(", ")}`,
    );
  }
  const rawTar = zlib.gunzipSync(fs.readFileSync(tarball));
  if (rawTar.includes("LIBARCHIVE.xattr")) {
    throw new Error(
      `[bundle] xattr pax headers in ${path.basename(tarball)} — the host's ` +
        "GNU tar warns once per file; build with --no-xattrs intact.",
    );
  }
  fs.rmSync(stage, { recursive: true, force: true });

  const data = fs.readFileSync(tarball);
  const sha256 = createHash("sha256").update(data).digest("hex");
  index.bundles.push({
    arch,
    file: path.basename(tarball),
    sha256,
    bytes: data.length,
    nodeVersion,
    omitted: missing,
  });

  console.log(
    `[bundle] ${arch}: ${path.basename(tarball)} ${(data.length / 1024 / 1024).toFixed(1)} MB` +
      (missing.length ? `  (omitted: ${missing.join(", ")})` : ""),
  );
}

fs.writeFileSync(path.join(outRoot, "index.json"), JSON.stringify(index, null, 2));
console.log(`[bundle] index.json written for version ${version}`);
