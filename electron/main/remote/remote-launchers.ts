/**
 * remote-launchers.ts — Spawn-spec builders for launchers in remote sessions.
 *
 * Responsibilities:
 * - Decide how a configured editor command translates to a remote session:
 *   Remote-SSH-capable GUI editors spawn locally with `--remote`, TUI
 *   editors run on the host inside an ssh channel, everything else refuses
 *   with an actionable message.
 * - Build the `ssh -t` argv that carries a TUI editor or a login shell to
 *   the session's host over PDV's ControlMaster.
 *
 * Non-responsibilities:
 * - Spawning processes or touching the filesystem — callers pass the specs
 *   to `child_process.spawn`.
 * - Master lifecycle. The {@link SshControl} handed in is assumed live; a
 *   dead master surfaces as ssh's own error inside the user's terminal,
 *   where they can answer an auth prompt (which is why, unlike
 *   `baseSshArgs`, nothing here forces `BatchMode=yes`).
 *
 * Shell-side only: this module imports `ssh-mux` and must never be pulled
 * into the pdv-server bundle (`electron-free.test.ts` guards the reverse
 * direction — server-destined files cannot import `main/remote/*`).
 */

import * as path from "path";
import {
  buildEditorSpawn,
  isTerminalEditorCommand,
  posixShellQuote,
} from "../editor-spawn";
import { controlPathOption, type SshControl } from "./ssh-mux";

/**
 * GUI editors whose CLI understands VS Code's Remote-SSH addressing
 * (`--remote ssh-remote+<host> <path>`). Cursor and Windsurf are VS Code
 * forks that kept the flag. Matched on the command's basename so a full
 * path to the binary still routes.
 */
const REMOTE_CAPABLE_EDITORS = new Set([
  "code",
  "code-insiders",
  "cursor",
  "windsurf",
]);

/**
 * How a configured editor command should be launched for a remote session.
 *
 * - `local-spawn` — spawn locally as-is (a Remote-SSH-capable editor; it
 *   makes its own ssh connection using the user's config alias).
 * - `ssh-terminal` — run `remoteCommand` on the host via
 *   {@link buildSshLauncherCommand}, wrapped in the user's terminal preset.
 * - `unsupported` — the editor has no remote story; `message` explains the
 *   alternatives.
 */
export type RemoteEditorResolution =
  | { kind: "local-spawn"; file: string; args: string[] }
  | { kind: "ssh-terminal"; remoteCommand: string }
  | { kind: "unsupported"; message: string };

/**
 * Resolve a configured editor command against a remote session target.
 *
 * Resolution order:
 * 1. An explicit config template (`launchers.editor.remoteFileCommand` /
 *    `remoteDirCommand`) wins outright. `{host}`/`{path}` are substituted
 *    inside tokens (so `ssh-remote+{host}` works); a template without
 *    `{path}` gets the path appended.
 * 2. A TUI editor (the explicit `isTuiEditor` flag, else basename
 *    auto-detection) becomes an `ssh-terminal` command running the editor
 *    on the host — riding PDV's master means no re-auth and landing on the
 *    session's pinned node.
 * 3. A Remote-SSH-capable basename becomes a local spawn with
 *    `--remote ssh-remote+<host>`; user flags from the command survive.
 * 4. Anything else is `unsupported`.
 *
 * @param cmdString - Raw command from config (defaults to `"code {}"`).
 * @param opts - Target host + path, optional template and TUI override.
 * @returns The resolution — never throws.
 */
export function resolveRemoteEditorSpawn(
  cmdString: string | undefined,
  opts: {
    host: string;
    targetPath: string;
    template?: string;
    isTuiEditor?: boolean;
  },
): RemoteEditorResolution {
  const template = opts.template?.trim();
  if (template) {
    const parts = template.split(/\s+/).filter(Boolean);
    const expanded = parts.map((part) =>
      part.replace(/\{host\}/g, opts.host).replace(/\{path\}/g, opts.targetPath),
    );
    const argv = template.includes("{path}")
      ? expanded
      : [...expanded, opts.targetPath];
    return { kind: "local-spawn", file: argv[0], args: argv.slice(1) };
  }

  const raw = (cmdString ?? "code {}").trim() || "code {}";
  const parts = raw.split(/\s+/).filter(Boolean);
  const bin = parts[0];

  const tui = opts.isTuiEditor ?? isTerminalEditorCommand(bin);
  if (tui) {
    const spec = buildEditorSpawn(raw, opts.targetPath);
    const remoteCommand = [spec.file, ...spec.args]
      .map(posixShellQuote)
      .join(" ");
    return { kind: "ssh-terminal", remoteCommand };
  }

  const basename = path.basename(bin).toLowerCase().replace(/\.exe$/, "");
  if (REMOTE_CAPABLE_EDITORS.has(basename)) {
    const flags = parts.slice(1).filter((part) => part !== "{}");
    return {
      kind: "local-spawn",
      file: bin,
      args: [...flags, "--remote", `ssh-remote+${opts.host}`, opts.targetPath],
    };
  }

  return {
    kind: "unsupported",
    message:
      `"${bin}" cannot open files on the remote host. Use VS Code, Cursor, or ` +
      `Windsurf (they connect via Remote SSH), pick a terminal editor like vim, ` +
      `or set a custom remote command in the launchers config ` +
      `(launchers.editor.remoteFileCommand).`,
  };
}

/**
 * Build the `ssh` argv that runs a command on the session's host inside a
 * terminal the user can see.
 *
 * `-t` forces tty allocation (ssh skips it when given a remote command), so
 * TUI editors and login shells behave exactly as in a hand-typed ssh. The
 * ControlPath rides PDV's master when one exists — no second auth prompt,
 * and the channel lands on the same login node as the session, which
 * matters when the working dir is node-local scratch. `BatchMode` is
 * deliberately not forced: this runs in a visible terminal where an auth
 * prompt is answerable if the master has died.
 *
 * @param control - The session's host + control socket (null path = the
 *   user's own ssh config supplies the master).
 * @param remoteCommand - Shell command to run on the host (already quoted
 *   by the caller where needed).
 * @param opts - Optional ssh binary override (test seam).
 * @returns Spawn-ready file + args for the local `ssh` process.
 */
export function buildSshLauncherCommand(
  control: SshControl,
  remoteCommand: string,
  opts?: { sshPath?: string },
): { file: string; args: string[] } {
  const args = ["-t", "-o", "RemoteCommand=none"];
  if (control.controlPath) {
    args.push("-o", controlPathOption(control.controlPath));
  }
  args.push(control.host, remoteCommand);
  return { file: opts?.sshPath ?? "ssh", args };
}

/**
 * Shell command that lands an interactive login shell in a working
 * directory on the remote host.
 *
 * `cd` failure is separated with `;` rather than `&&` so a purged working
 * dir (scratch retention on clusters) still opens a shell at `$HOME` with a
 * visible `cd` error, instead of a window that closes before it can be
 * read. `${SHELL:-sh}` guards the (rare) unset-`SHELL` environment.
 *
 * @param workingDir - Directory to land in, or null for `$HOME`.
 * @returns A POSIX shell command string for the ssh remote side.
 */
export function remoteLoginShellCommand(workingDir: string | null): string {
  const cd = workingDir ? `cd ${posixShellQuote(workingDir)}; ` : "";
  return `${cd}exec "\${SHELL:-sh}" -l`;
}
