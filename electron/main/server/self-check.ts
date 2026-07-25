/**
 * self-check.ts — Prove an installed pdv-server bundle actually works.
 *
 * A bundle can unpack perfectly and still be useless: the wrong libc, a
 * Node whose ABI does not match the vendored zeromq addon, a home directory
 * mounted `noexec`, a filesystem with no space to write a socket. Every one
 * of those surfaces much later as an inscrutable failure — a kernel that
 * never starts, a connection that hangs — on a machine the user cannot
 * easily debug.
 *
 * So installation ends by *running* the bundle once and asking it to do the
 * two things that actually matter, on the host where it will live:
 *
 * 1. **`dlopen` the zeromq addon.** Loading the module is not enough; the
 *    binding is resolved lazily, so the check binds a real socket to force
 *    it. This is what catches an ABI or libc mismatch.
 * 2. **Create and remove a temp directory.** Kernel sessions need scratch
 *    space; a read-only or full filesystem must fail here, loudly, not
 *    halfway through a user's first project.
 *
 * The verdict is one JSON line on stdout — the only mode where stdout is
 * not the RPC protocol channel — so the caller can read it over an ssh
 * command with no framing and no ambiguity.
 *
 * This module does NOT install anything, fetch anything, or touch the
 * session; it inspects the environment it was launched in and reports.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** One check's outcome. */
export interface SelfCheckStep {
  name: string;
  ok: boolean;
  /** Present when `ok` is false, or when the step has a useful value. */
  detail?: string;
}

/** Machine-readable verdict, printed as a single JSON line. */
export interface SelfCheckReport {
  /** Discriminator so a caller can recognise the line amid shell noise. */
  pdv: "self-check";
  ok: boolean;
  version: string | null;
  node: string;
  /** Node's ABI (`process.versions.modules`) — what a native addon must match. */
  abi: string;
  platform: string;
  arch: string;
  steps: SelfCheckStep[];
}

/**
 * Force the zeromq native addon to load and bind.
 *
 * Requiring the module is not sufficient — zeromq resolves its addon lazily
 * through the cmake-ts loader, so a broken binary stays undetected until the
 * first socket. Binding to port 0 makes the kernel choose a free port, which
 * keeps the check side-effect-free and safe to run concurrently.
 *
 * @param zeromqPath - Explicit module path (`PDV_ZEROMQ_PATH`), or null to
 *   resolve `zeromq` normally.
 * @returns The step result; `detail` carries the bound endpoint on success.
 */
async function checkZeromq(zeromqPath: string | null): Promise<SelfCheckStep> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zmq = require(zeromqPath ?? "zeromq") as {
      Reply: new () => { bind(addr: string): Promise<void>; lastEndpoint: string | null; close(): void };
    };
    const socket = new zmq.Reply();
    try {
      await socket.bind("tcp://127.0.0.1:0");
      const endpoint = socket.lastEndpoint;
      if (!endpoint) {
        return { name: "zeromq", ok: false, detail: "bound socket reported no endpoint" };
      }
      return { name: "zeromq", ok: true, detail: endpoint };
    } finally {
      socket.close();
    }
  } catch (error) {
    return {
      name: "zeromq",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create and remove a temp directory, proving scratch space is usable.
 *
 * @returns The step result; `detail` carries the directory used.
 */
function checkTempDir(): SelfCheckStep {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-selfcheck-"));
    fs.writeFileSync(path.join(dir, "probe"), "ok");
    fs.readFileSync(path.join(dir, "probe"), "utf8");
    return { name: "tempdir", ok: true, detail: dir };
  } catch (error) {
    return {
      name: "tempdir",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup failure does not invalidate the check: the directory was
        // created and written, which is what was being verified.
      }
    }
  }
}

/**
 * Run every self-check and assemble the verdict.
 *
 * @returns The report. Never throws — a thrown check would leave the caller
 *   with no verdict at all, which is worse than a failing one.
 */
export async function runSelfCheck(): Promise<SelfCheckReport> {
  const steps: SelfCheckStep[] = [
    await checkZeromq(process.env.PDV_ZEROMQ_PATH ?? null),
    checkTempDir(),
  ];
  return {
    pdv: "self-check",
    ok: steps.every((step) => step.ok),
    version: process.env.PDV_BUILD_VERSION ?? process.env.PDV_APP_VERSION ?? null,
    node: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    steps,
  };
}
