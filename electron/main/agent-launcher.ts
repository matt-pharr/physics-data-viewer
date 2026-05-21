/**
 * agent-launcher.ts — Build the spawn spec for the action-bar AI-agent button.
 *
 * Responsibilities:
 * - Expand the configured agent command's `{mcpConfig}` / `{projectRoot}` /
 *   `{workingDir}` placeholders.
 * - Wrap the agent CLI in a shell that `cd`s to the target directory, then
 *   wrap that in the user's terminal-emulator preset.
 *
 * Non-responsibilities:
 * - Spawning the process (the IPC handler does that).
 * - Writing the `.pdv-mcp.json` file (see `mcp/mcp-config-writer.ts`).
 *
 * Why a `cd … &&` shell wrapper rather than the `spawn` `cwd` option:
 * argv-style terminals (`alacritty -e …`) inherit the spawn cwd, but the
 * macOS osascript presets tell Terminal.app/iTerm2 to open a *new* shell
 * that starts in `$HOME` regardless of the osascript process's cwd. Putting
 * the `cd` inside the command itself is the one approach that works for
 * every preset.
 */

import {
  DEFAULT_AGENT_COMMAND,
  posixShellQuote,
  resolveEditorSpawn,
  type AgentLauncherConfig,
  type TerminalLauncherConfig,
} from "./editor-spawn";

/** Inputs for {@link buildAgentInvocation}. */
export interface BuildAgentInvocationOptions {
  /** `launchers.agent` config (command + cwd mode). */
  agent?: AgentLauncherConfig;
  /** `launchers.terminal` config (which terminal emulator to wrap in). */
  terminal?: TerminalLauncherConfig;
  /** Absolute path of the materialized `.pdv-mcp.json`. */
  mcpConfigPath: string;
  /** Active project directory, or `null` when no project is loaded. */
  projectRoot: string | null;
  /** Active kernel's session working directory. */
  workingDir: string;
  /** Target platform; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Quote a path for a `cmd.exe` command line. Windows paths don't contain
 * the shell metacharacters that would need escaping; wrapping in double
 * quotes covers the realistic case (spaces in the path).
 */
function cmdQuote(arg: string): string {
  return `"${arg}"`;
}

/**
 * Build the spawn spec for launching the configured AI agent.
 *
 * The agent CLI is run inside a login shell (`sh -lc` on POSIX, `cmd /c` on
 * Windows) that first `cd`s into the target directory, and that shell is in
 * turn wrapped in the user's terminal-emulator preset via
 * {@link resolveEditorSpawn} (with `wrapInTerminal` forced on — the agent
 * always needs a terminal window).
 *
 * @param opts - See {@link BuildAgentInvocationOptions}.
 * @returns Spawn-ready `{ file, args }` for `child_process.spawn`.
 */
export function buildAgentInvocation(
  opts: BuildAgentInvocationOptions,
): { file: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === "win32";
  const quote = isWindows ? cmdQuote : posixShellQuote;

  const command =
    (opts.agent?.command ?? DEFAULT_AGENT_COMMAND).trim() || DEFAULT_AGENT_COMMAND;
  const cwdMode = opts.agent?.cwd ?? "project";
  // `working` always exists; `project` falls back to the working directory
  // when no project has been saved yet.
  const targetDir =
    cwdMode === "working"
      ? opts.workingDir
      : (opts.projectRoot ?? opts.workingDir);

  const expandedCommand = command
    .replace(/\{mcpConfig\}/g, quote(opts.mcpConfigPath))
    .replace(/\{projectRoot\}/g, quote(opts.projectRoot ?? opts.workingDir))
    .replace(/\{workingDir\}/g, quote(opts.workingDir));

  const shellFile = isWindows ? "cmd" : "sh";
  const shellArgs = isWindows
    ? ["/c", `cd /d ${quote(targetDir)} && ${expandedCommand}`]
    : ["-lc", `cd ${quote(targetDir)} && exec ${expandedCommand}`];

  return resolveEditorSpawn(shellFile, shellArgs, {
    wrapInTerminal: true,
    terminal: opts.terminal,
    platform,
  });
}
