/**
 * editor-spawn.ts — External editor command expansion helpers.
 *
 * Responsibilities:
 * - Expand configured editor command templates with target file paths.
 * - Adapt terminal editors on macOS to launch inside Terminal.app.
 *
 * Non-responsibilities:
 * - Opening processes directly.
 * - Reading/writing project or config files.
 */

import * as path from "path";

const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "pico",
  "emacs",
  "kak",
  "hx",
  "helix",
]);

function isTerminalEditorCommand(command: string): boolean {
  const bin = path.basename(command).toLowerCase().replace(/\.exe$/, "");
  return TERMINAL_EDITORS.has(bin);
}

function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve and expand an editor command for a given file path.
 *
 * The command string may contain `{}` as a placeholder for the file path.
 * If no placeholder is present the path is appended as the last argument.
 * Defaults to `"code {}"` (VS Code) when no command is configured.
 *
 * @param cmdString - Raw command string from config, e.g. `"nvim {}"`.
 * @param filePath - Absolute path to the file to open.
 * @returns Object with the executable and expanded argument list.
 */
export function buildEditorSpawn(
  cmdString: string | undefined,
  filePath: string,
): { file: string; args: string[] } {
  const raw = (cmdString ?? "code {}").trim() || "code {}";
  const parts = raw.split(/\s+/).filter(Boolean);
  const placeholder = "{}";
  const hasPlaceholder = parts.includes(placeholder);
  const expanded = hasPlaceholder
    ? parts.map((part) => (part === placeholder ? filePath : part))
    : [...parts, filePath];
  return { file: expanded[0], args: expanded.slice(1) };
}

/**
 * Resolve platform-specific spawn command/args for launching an editor.
 *
 * On macOS, terminal editors are wrapped through `osascript` so they open in
 * Terminal.app.
 *
 * @param command - Executable command.
 * @param args - Command arguments.
 * @returns Spawn-ready executable and argument list.
 */
export function resolveEditorSpawn(
  command: string,
  args: string[],
): { file: string; args: string[] } {
  if (process.platform === "darwin" && isTerminalEditorCommand(command)) {
    const shellCommand = [command, ...args].map(quoteShellArg).join(" ");
    return {
      file: "osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(shellCommand)}`,
        "-e",
        'tell application "Terminal" to activate',
      ],
    };
  }
  return { file: command, args };
}
