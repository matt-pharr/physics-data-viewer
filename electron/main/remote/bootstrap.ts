/**
 * bootstrap.ts — Get a working pdv-server onto a remote host.
 *
 * Probe what is there, upload the bundle if needed, verify it, unpack it
 * atomically, and make it prove itself before anything depends on it. Every
 * step reports progress, because this is the slowest thing PDV ever does on
 * a first connect and silence would read as a hang.
 *
 * Three rules the layout follows, each from a failure that is otherwise
 * invisible until much later:
 *
 * 1. **Never unpack into the final directory.** A half-extracted
 *    `<version>/` looks installed to the next probe, so the next connect
 *    skips the install and fails mysteriously. Extraction goes to
 *    `.tmp-<nonce>/` and is moved into place with `mv` — same parent, so
 *    `rename(2)`, so atomic.
 * 2. **Verify before trusting.** The sha256 is checked *on the host* after
 *    upload. A truncated transfer over a flaky VPN otherwise unpacks into a
 *    subtly broken install.
 * 3. **Cache the verdict, not the assumption.** A passing self-check is
 *    written to `<version>/.selfcheck.json`, so a later connect confirms the
 *    install in one round trip instead of re-running the whole check —
 *    while still never assuming an unverified directory is good.
 *
 * What this does NOT do: authenticate (the master already exists), start a
 * session, or decide *when* to bootstrap. It reports; the caller acts.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.7
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import * as crypto from "crypto";
import * as fs from "fs";

import {
  baseSshArgs,
  execViaSsh,
  type SshControl,
  type SshMuxOptions,
} from "./ssh-mux";

/** Root of PDV's install tree on the remote host, relative to `$HOME`. */
// Must agree with `defaultRoot()` in server/server-main.ts — the attach
// CLI resolves the same directory on the host from its own default.
const REMOTE_ROOT = ".pdv-server";

/*
 * Remote paths are interpolated into shell commands with DOUBLE quotes, not
 * single, because they contain `$HOME` and must expand on the host. PDV does
 * not know the remote home path until it probes, and hard-coding one would
 * break on a cluster with a non-standard layout. Every value interpolated
 * here is PDV's own (a version from package.json, a hex nonce), never user
 * input, so expansion is safe.
 */

/** Minimum glibc that a modern Node runtime requires. */
const MIN_GLIBC = [2, 28] as const;

/** What a probe learned about the host. */
export interface HostProbe {
  ok: boolean;
  /** `uname -s`, e.g. `Linux`. */
  sys: string | null;
  /** `uname -m`, e.g. `x86_64` / `aarch64`. */
  machine: string | null;
  /** Normalised arch for bundle selection, or null when unsupported. */
  arch: "x64" | "arm64" | null;
  /** e.g. `glibc 2.35`, or `musl`. */
  libc: string | null;
  home: string | null;
  homeWritable: boolean;
  /** Free space in the home filesystem, in bytes. */
  freeBytes: number | null;
  /** True when this exact version is installed and its self-check passed. */
  installed: boolean;
  /**
   * sha256 of the bundle the host actually has, or null when none is
   * recorded.
   *
   * Compared by the caller against the bundle it would install. Version
   * alone is not enough: a rebuild that does not bump the version would
   * otherwise never replace the installed copy, leaving the host serving a
   * bundle missing whatever the shell has since come to depend on — which is
   * exactly how a working connect ends in "server stream ended".
   */
  bundleId: string | null;
  /** Set when `ok` is false: an operator-facing explanation. */
  problem: string | null;
}

/** Progress emitted while bootstrapping. */
export interface BootstrapProgress {
  /** Coarse stage, for the label. */
  stage: "probing" | "uploading" | "verifying" | "installing" | "checking";
  message: string;
  /** Bytes transferred so far, during `uploading`. */
  transferred?: number;
  /** Total bytes to transfer, during `uploading`. */
  total?: number;
}

/** Options shared by the bootstrap steps. */
export interface BootstrapOptions extends SshMuxOptions {
  /** Version being installed; names the directory under `~/.pdv-server`. */
  version: string;
  /** Called for every progress update. */
  onProgress?: (progress: BootstrapProgress) => void;
}

/** Outcome of an install attempt. */
export interface InstallResult {
  ok: boolean;
  /**
   * Remote path of the install, when successful — **shell-expandable, not
   * resolved**: it contains `$HOME` because that is how every later command
   * uses it, and resolving it would cost a round trip to produce a string
   * that then has to be re-quoted anyway. Interpolate it into a command with
   * double quotes, never single.
   */
  installDir: string | null;
  /** Operator-facing explanation. */
  message: string;
  /** The self-check verdict line, when one was produced. */
  selfCheck: unknown | null;
}

/**
 * Shell script the probe runs on the host.
 *
 * Deliberately POSIX `sh` with no arrays, no `local`, and no GNU-only flags:
 * it runs under whatever login shell the cluster provides, before PDV has
 * put anything of its own on the machine.
 *
 * @param version - Version to look for.
 * @param nonce - Echoed back so the reply can be told apart from banner noise.
 * @returns Shell source.
 */
function probeScript(version: string, nonce: string): string {
  return `
sys=$(uname -s 2>/dev/null || echo unknown)
mach=$(uname -m 2>/dev/null || echo unknown)
libc=$(ldd --version 2>&1 | head -1 | sed 's/"/ /g' || echo unknown)
home=\${HOME:-/nonexistent}
if [ -w "$home" ]; then hw=true; else hw=false; fi
free=$(df -kP "$home" 2>/dev/null | tail -1 | awk '{print $4}')
[ -z "$free" ] && free=0
inst=false
bid=none
# The recorded id is the installed tarball's sha256. It is reported rather
# than compared here because the caller only knows which bundle it *would*
# install once this probe has told it the architecture.
if [ -f "$home/${REMOTE_ROOT}/${version}/.selfcheck.json" ]; then
  inst=true
  bid=$(cat "$home/${REMOTE_ROOT}/${version}/.bundle-id" 2>/dev/null || echo none)
fi
printf '{"pdv":"probe","n":"%s","sys":"%s","mach":"%s","libc":"%s","home":"%s","homeWritable":%s,"freeKB":%s,"installed":%s,"bundleId":"%s"}\\n' \\
  "${nonce}" "$sys" "$mach" "$libc" "$home" "$hw" "$free" "$inst" "$bid"
`;
}

/** Pull the probe's JSON reply out of a stream that may carry banner noise. */
function parseProbeReply(stdout: string, nonce: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes(nonce)) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.pdv === "probe" && parsed.n === nonce) return parsed;
    } catch {
      // Not ours; keep looking.
    }
  }
  return null;
}

/** Map `uname -m` onto the architectures PDV builds bundles for. */
function normalizeArch(machine: string | null): "x64" | "arm64" | null {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  return null;
}

/**
 * Whether the host's glibc is new enough for the bundled Node.
 *
 * A musl host is accepted: zeromq ships musl prebuilds at the same ABI, so
 * Alpine-based images are servable.
 *
 * @param libc - The raw `ldd --version` first line.
 * @returns An explanation when too old, or null when acceptable.
 */
function glibcProblem(libc: string | null): string | null {
  if (!libc) return null;
  if (/musl/i.test(libc)) return null;
  const match = /(\d+)\.(\d+)/.exec(libc);
  if (!match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > MIN_GLIBC[0] || (major === MIN_GLIBC[0] && minor >= MIN_GLIBC[1])) return null;
  return (
    `This host has glibc ${major}.${minor}, but PDV's remote components need ` +
    `${MIN_GLIBC[0]}.${MIN_GLIBC[1]} or newer. The host is too old to run them.`
  );
}

/**
 * Ask the host what it is and what it already has.
 *
 * @param control - A live control socket.
 * @param options - Version to look for, and ssh options.
 * @returns What was learned. `ok` false carries an actionable `problem`.
 */
export async function probeHost(
  control: SshControl,
  options: BootstrapOptions,
): Promise<HostProbe> {
  options.onProgress?.({ stage: "probing", message: `Checking ${control.host}…` });

  const nonce = `pdvp${crypto.randomBytes(6).toString("hex")}`;
  const result = await execViaSsh(
    control,
    probeScript(options.version, nonce),
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
  );

  const empty: HostProbe = {
    ok: false, sys: null, machine: null, arch: null, libc: null,
    home: null, homeWritable: false, freeBytes: null, installed: false,
    bundleId: null, problem: null,
  };

  if (result.failure) {
    return { ...empty, problem: `Could not reach ${control.host} (${result.failure}).` };
  }
  const reply = parseProbeReply(result.stdout, nonce);
  if (!reply) {
    return {
      ...empty,
      problem:
        `${control.host} did not answer PDV's probe. Its login shell may print ` +
        "something PDV could not parse; see the connection log.",
    };
  }

  const machine = typeof reply.mach === "string" ? reply.mach : null;
  const libc = typeof reply.libc === "string" ? reply.libc : null;
  const probe: HostProbe = {
    ok: true,
    sys: typeof reply.sys === "string" ? reply.sys : null,
    machine,
    arch: normalizeArch(machine),
    libc,
    home: typeof reply.home === "string" ? reply.home : null,
    homeWritable: reply.homeWritable === true,
    freeBytes: typeof reply.freeKB === "number" ? reply.freeKB * 1024 : null,
    installed: reply.installed === true,
    bundleId:
      typeof reply.bundleId === "string" && reply.bundleId !== "none"
        ? reply.bundleId
        : null,
    problem: null,
  };

  if (probe.sys !== "Linux") {
    return { ...probe, ok: false, problem: `PDV can only run a remote session on Linux (this host reports ${probe.sys ?? "unknown"}).` };
  }
  if (!probe.arch) {
    return { ...probe, ok: false, problem: `Unsupported architecture ${machine ?? "unknown"}; PDV ships x86_64 and arm64 components.` };
  }
  const libcIssue = glibcProblem(libc);
  if (libcIssue) return { ...probe, ok: false, problem: libcIssue };
  if (!probe.homeWritable) {
    return { ...probe, ok: false, problem: `PDV cannot write to ${probe.home ?? "your home directory"} on ${control.host}.` };
  }
  return probe;
}

/**
 * Stream a local file to a remote path over the multiplexed connection.
 *
 * Uses its own spawn rather than {@link execViaSsh} because the payload is
 * stdin, not an argument, and progress has to be reported as it goes. The
 * destination is written under a temporary name by the caller, so an
 * interrupted transfer never looks like a complete one.
 *
 * @param control - A live control socket.
 * @param localPath - File to send.
 * @param remotePath - Destination path on the host.
 * @param options - Version, progress sink and ssh options.
 * @returns True when the transfer completed and the remote write succeeded.
 */
export async function uploadFile(
  control: SshControl,
  localPath: string,
  remotePath: string,
  options: BootstrapOptions,
): Promise<boolean> {
  const total = fs.statSync(localPath).size;
  const args = [
    ...baseSshArgs(control, options),
    "-o",
    "ControlMaster=no",
    control.host,
    `cat > "${remotePath}"`,
  ];

  return await new Promise<boolean>((resolve) => {
    const child = spawn(options.sshPath ?? "ssh", args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let transferred = 0;
    let stderr = "";

    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });

    const source = fs.createReadStream(localPath);
    source.on("data", (chunk: string | Buffer) => {
      transferred += chunk.length;
      options.onProgress?.({
        stage: "uploading",
        message: `Sending PDV's remote components to ${control.host}…`,
        transferred,
        total,
      });
    });
    source.on("error", () => resolve(false));
    if (child.stdin) source.pipe(child.stdin);

    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      if (code !== 0 && stderr) {
        // Quota and permission failures land here, and their wording is the
        // most useful thing PDV can show.
        options.onProgress?.({ stage: "uploading", message: stderr.trim().split("\n")[0] });
      }
      resolve(code === 0 && transferred === total);
    });
  });
}

/**
 * Install a bundle on the host: upload, verify, unpack atomically, self-check.
 *
 * @param control - A live control socket.
 * @param tarball - Local path of the per-arch tarball.
 * @param sha256 - Expected digest, verified on the host after transfer.
 * @param options - Version, progress sink and ssh options.
 * @returns The outcome, with the self-check verdict when one was produced.
 */
export async function installBundle(
  control: SshControl,
  tarball: string,
  sha256: string,
  options: BootstrapOptions,
): Promise<InstallResult> {
  const { version } = options;
  const root = `$HOME/${REMOTE_ROOT}`;
  const nonce = crypto.randomBytes(6).toString("hex");
  const staging = `${root}/.tmp-${version}-${nonce}`;
  const archive = `${root}/.upload-${nonce}.tar.gz`;

  const prep = await execViaSsh(control, `mkdir -p "${root}" && chmod 700 "${root}"`, options);
  if (!prep.ok) {
    return {
      ok: false, installDir: null, selfCheck: null,
      message: `Could not create ${REMOTE_ROOT} on ${control.host}. ${prep.stderr.trim()}`,
    };
  }

  if (!(await uploadFile(control, tarball, archive, options))) {
    await execViaSsh(control, `rm -f "${archive}"`, options);
    return {
      ok: false, installDir: null, selfCheck: null,
      message:
        `Uploading PDV's remote components to ${control.host} failed. This is ` +
        "usually a disk quota or a dropped connection.",
    };
  }

  options.onProgress?.({ stage: "verifying", message: "Verifying the transfer…" });
  const verify = await execViaSsh(
    control,
    `cd "${root}" && echo '${sha256}  ${archive.replace(`${root}/`, "")}' | sha256sum -c -`,
    options,
  );
  if (!verify.ok) {
    await execViaSsh(control, `rm -f "${archive}"`, options);
    return {
      ok: false, installDir: null, selfCheck: null,
      message:
        "The uploaded components did not match their checksum, so PDV discarded " +
        "them. Try connecting again.",
    };
  }

  options.onProgress?.({ stage: "installing", message: "Installing…" });
  const target = `${root}/${version}`;
  // Unpack to staging, then rename into place: same parent directory, so the
  // move is rename(2) and a concurrent probe can never observe a partial
  // install. An existing target is replaced only once the new one is whole.
  // Removing the REPLACED install is best-effort, never part of the
  // install's success: on an NFS home, a still-running old daemon keeps
  // its files open, so rm leaves .nfs* silly-rename ghosts and exits
  // nonzero — which used to fail the whole chain AFTER the new install
  // was already renamed into place ("Unpacking failed" on a successful
  // install; seen live on feyn). The displaced dir gets a unique name so
  // a ghost-laden leftover from an earlier attempt can never absorb the
  // mv, and ghosts vanish on their own once the old daemon exits.
  const install = await execViaSsh(
    control,
    [
      `rm -rf "${staging}"`,
      `mkdir -p "${staging}"`,
      `tar -xzf "${archive}" -C "${staging}"`,
      `rm -f "${archive}"`,
      `(rm -rf "${target}.old" "${target}".old.* 2>/dev/null || true)`,
      `if [ -d "${target}" ]; then mv "${target}" "${target}.old.$$"; fi`,
      `mv "${staging}" "${target}"`,
      `(rm -rf "${target}.old" "${target}".old.* 2>/dev/null || true)`,
    ].join(" && "),
    { ...options, timeoutMs: options.timeoutMs ?? 180_000 },
  );
  if (!install.ok) {
    await execViaSsh(control, `rm -rf "${staging}" "${archive}"`, options);
    return {
      ok: false, installDir: null, selfCheck: null,
      message: `Unpacking failed on ${control.host}. ${install.stderr.trim()}`,
    };
  }

  options.onProgress?.({ stage: "checking", message: "Verifying the installation…" });
  const check = await execViaSsh(
    control,
    `cd "${target}" && PDV_ZEROMQ_PATH="${target}/node_modules/zeromq" ./node/bin/node pdv-server.cjs self-check`,
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
  );
  const verdict = parseSelfCheck(check.stdout);
  if (!check.ok || !verdict || verdict.ok !== true) {
    return {
      ok: false, installDir: null, selfCheck: verdict,
      message:
        `PDV installed its components on ${control.host} but they do not run there. ` +
        (describeSelfCheckFailure(verdict) ?? check.stderr.trim()),
    };
  }

  // Cache the verdict so a later connect confirms the install in one round
  // trip. Written only after a pass — never as an assumption.
  await execViaSsh(
    control,
    // The bundle id is written alongside the verdict and only after the
    // self-check passed: the probe treats its *value* as proof that this
    // exact bundle — not merely this version — works on this host.
    `printf '%s' '${JSON.stringify(verdict).replace(/'/g, "")}' > "${target}/.selfcheck.json" && ` +
      `printf '%s' '${sha256}' > "${target}/.bundle-id"`,
    options,
  );

  return {
    ok: true,
    installDir: target,
    selfCheck: verdict,
    message: `PDV's remote components are ready on ${control.host}.`,
  };
}

/**
 * The shell command that runs `pdv-server` on a host, ready for arguments.
 *
 * Deliberately returns a *shell fragment* rather than a path: the install
 * lives under `$HOME`, needs its zeromq loader pointed at the bundled copy,
 * and must run from its own directory. Callers append their subcommand.
 *
 * The `$HOME` is left unquoted-by-design so the remote shell expands it —
 * quoting the whole fragment would produce a literal `$HOME` and a command
 * that is not found.
 *
 * @param version - Installed bundle version.
 * @returns A shell fragment ending in the `pdv-server.cjs` invocation.
 */
export function remoteServerCommand(version: string): string {
  const target = `$HOME/${REMOTE_ROOT}/${version}`;
  return (
    `cd "${target}" && PDV_ZEROMQ_PATH="${target}/node_modules/zeromq" ` +
    // Without the resources root, every bundled asset is invisible to the
    // server — resolveUvBinary finds no uv, the one-click install finds no
    // pdv-python wheel — and a kernel start on a fresh host dies with
    // "Could not locate the uv binary" (observed on a real cluster).
    `PDV_RESOURCES_ROOT="${target}/resources" ` +
    `PDV_APP_VERSION="${version}" ./node/bin/node pdv-server.cjs`
  );
}

/** Verdict shape emitted by `pdv-server self-check`. */
interface SelfCheckVerdict {
  ok?: boolean;
  steps?: Array<{ name?: string; ok?: boolean; detail?: string }>;
}

/** Pull the self-check JSON line out of possibly noisy output. */
function parseSelfCheck(stdout: string): SelfCheckVerdict | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"self-check"')) continue;
    try {
      return JSON.parse(trimmed) as SelfCheckVerdict;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Turn a failed self-check into something a physicist can act on.
 *
 * @param verdict - The parsed verdict, or null when none was produced.
 * @returns An explanation, or null when there is nothing specific to say.
 */
function describeSelfCheckFailure(verdict: SelfCheckVerdict | null): string | null {
  const failed = verdict?.steps?.find((step) => step.ok === false);
  if (!failed) return null;
  if (failed.name === "zeromq") {
    return (
      "Its messaging library could not load, which usually means the host's " +
      `system libraries are older than PDV's components expect. (${failed.detail ?? ""})`
    );
  }
  if (failed.name === "tempdir") {
    return `PDV could not write scratch files there. (${failed.detail ?? ""})`;
  }
  return failed.detail ?? null;
}

/**
 * Compute a file's sha256, for verifying a bundle before sending it.
 *
 * @param filePath - File to digest.
 * @returns Lowercase hex digest.
 */
export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
