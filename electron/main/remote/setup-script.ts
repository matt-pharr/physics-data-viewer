/**
 * setup-script.ts — Ship the per-host setup script to a remote session.
 *
 * A cluster session often needs environment setup that only the user can
 * specify — `module load python`, a conda activate, a scratch PATH entry.
 * The master copy of that script lives on the LAPTOP, one file per host
 * alias under `<userData>/remote-setup/<host>.sh`, so it is editable while
 * offline and survives reinstalls on the cluster. At session start it is
 * written to the session directory on the host
 * (`~/.pdv-server/run/sessions/<id>/setup.sh`), where the daemon's
 * login-environment capture (`server/login-env.ts`) sources it on its next
 * start.
 *
 * When no script is configured locally the remote copy is removed, so
 * deleting the local file is how a host is un-configured — a stale script
 * silently shaping every kernel's environment would be worse than none.
 *
 * Script contract: it is sourced by `bash -l` with all output discarded,
 * and environment mutations are its entire effect. Variables named `PDV_*`
 * (and `ELECTRON_RUN_AS_NODE`) are the daemon's own namespace — exports
 * under that prefix are silently discarded by the login-env application.
 *
 * This module does NOT decide when shipping happens (`ipc-register-remote`
 * ships at session start), provide editing UI (a Settings tab does, later),
 * or interpret the script — it is content, not configuration.
 */

import * as fs from "fs";
import * as path from "path";

import { posixShellQuote } from "../editor-spawn";
import { execViaSsh, type SshControl } from "./ssh-mux";

/** Options for {@link shipSetupScript}. */
export interface ShipSetupScriptOptions {
  /** Live control connection to the host. */
  control: SshControl;
  /** Host alias as the user typed it — keys the local master copy. */
  host: string;
  /** Session whose directory receives the script. */
  sessionId: string;
  /** Directory of local master copies (`<userData>/remote-setup`). */
  setupScriptDir: string;
  /** `ssh` binary override (the PDV_SSH_PATH seam). */
  sshPath?: string;
  /** Injected by tests; production uses {@link execViaSsh}. */
  exec?: typeof execViaSsh;
}

/** Outcome of {@link shipSetupScript}. */
export type ShipSetupScriptResult =
  | {
      ok: true;
      /** True when a script was written; false when none is configured. */
      shipped: boolean;
    }
  | { ok: false; message: string };

/**
 * Local master-copy path for a host's setup script.
 *
 * The alias becomes a filename, so anything the filesystem might interpret
 * is replaced. Two aliases that collide after sanitization share a script,
 * which is harmless: aliases that close over the same characters are
 * overwhelmingly the same host family.
 *
 * @param setupScriptDir - Directory of master copies.
 * @param host - Host alias.
 * @returns Absolute path of the master copy (existence not checked).
 */
export function localSetupScriptPath(setupScriptDir: string, host: string): string {
  const safe = host.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(setupScriptDir, `${safe}.sh`);
}

/**
 * Write (or remove) the session's setup script on the connected host.
 *
 * The write is atomic on the remote side (`.tmp` then `mv`) so a daemon
 * capturing mid-ship reads either the old script or the new one, never a
 * truncated file. Content travels as a single-quoted literal — POSIX
 * quoting via {@link posixShellQuote}, never string interpolation of paths
 * or content into shell syntax.
 *
 * @param options - Connection, host alias, session id and local directory.
 * @returns `ok: true` with whether a script was shipped; `ok: false` with a
 *   user-facing message when a configured script could not be delivered
 *   (failing loudly beats a session whose interpreters are silently
 *   missing). Removal failures are logged but reported as success — the
 *   exotic failure there does not endanger the session being started.
 */
export async function shipSetupScript(
  options: ShipSetupScriptOptions,
): Promise<ShipSetupScriptResult> {
  const exec = options.exec ?? execViaSsh;
  const localPath = localSetupScriptPath(options.setupScriptDir, options.host);

  let content: string | null;
  try {
    // CRLF is normalized at read time: the master copy is PDV-owned
    // configuration a user may edit with anything, and a shipped `\r`
    // embeds itself in every exported value (`FOO=bar\r`) or breaks
    // `module load python\r` invisibly — the capture discards the output
    // where the error would have shown.
    const raw = fs.readFileSync(localPath, "utf8").replace(/\r\n/g, "\n");
    content = raw.trim().length > 0 ? raw : null;
  } catch {
    content = null; // No master copy: treat as unconfigured.
  }

  // `"$HOME/..."'<id>'` — adjacent quoted strings concatenate in POSIX sh,
  // so the id rides in its own single-quoted literal.
  const sessionDir = `"$HOME/.pdv-server/run/sessions/"${posixShellQuote(options.sessionId)}`;

  if (content === null) {
    const result = await exec(
      options.control,
      `rm -f ${sessionDir}"/setup.sh"`,
      { sshPath: options.sshPath },
    );
    if (!result.ok) {
      console.error(
        `[remote] could not remove the setup script on ${options.host}: ` +
          `${result.stderr.trim() || (result.failure ?? "unknown")}`,
      );
    }
    return { ok: true, shipped: false };
  }

  const command =
    `mkdir -p ${sessionDir} && ` +
    `printf '%s' ${posixShellQuote(content)} > ${sessionDir}"/setup.sh.tmp" && ` +
    `mv ${sessionDir}"/setup.sh.tmp" ${sessionDir}"/setup.sh"`;
  const result = await exec(options.control, command, { sshPath: options.sshPath });
  if (!result.ok) {
    return {
      ok: false,
      message:
        `The setup script for ${options.host} could not be delivered: ` +
        `${result.stderr.trim() || (result.failure ?? "unknown failure")}. ` +
        `Fix or remove ${localPath} and try again.`,
    };
  }
  return { ok: true, shipped: true };
}
