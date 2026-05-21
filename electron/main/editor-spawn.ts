/**
 * editor-spawn.ts — External editor command expansion and terminal wrapping.
 *
 * Responsibilities:
 * - Expand configured editor command templates with target file paths.
 * - Wrap TUI editor invocations in a user-configurable terminal preset so
 *   `vim` / `nvim` / `nano` etc. land in a real terminal window across
 *   macOS, Linux, and Windows.
 *
 * Non-responsibilities:
 * - Opening processes directly. Callers pass the returned spawn spec to
 *   `child_process.spawn(..., { shell: false })`. The expander emits argv
 *   directly — no shell layer is involved in the launch.
 * - Reading/writing project or config files.
 */

import * as path from "path";

/**
 * TUI editors whose basenames are auto-wrapped in a terminal. The list is
 * deliberately conservative; PR 2 of the launchers work replaces this with an
 * explicit user-controlled `isTuiEditor` flag.
 */
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

/**
 * The complete set of terminal-emulator presets PDV ships with, plus the two
 * meta-presets `'custom'` (use a user-supplied template) and `'none'` (skip
 * the wrapper entirely — opt-out for editors PDV's allowlist misclassifies).
 *
 * Exported as a constant array so {@link config.ts} can validate persisted
 * values against it without redeclaring the union.
 */
export const TERMINAL_PRESET_LIST = [
  "terminal-app",
  "iterm2",
  "ghostty",
  "alacritty",
  "kitty",
  "wezterm",
  "gnome-terminal",
  "konsole",
  "xterm",
  "x-terminal-emulator",
  "windows-terminal",
  "custom",
  "none",
] as const;

export type TerminalPreset = (typeof TERMINAL_PRESET_LIST)[number];

/**
 * User-configured terminal launcher selection. Persisted under
 * `PDVConfig.launchers.terminal`.
 */
export interface TerminalLauncherConfig {
  preset: TerminalPreset;
  /** Used only when `preset === 'custom'`. */
  customTemplate?: string;
}

/**
 * User-configured editor / IDE launcher. Persisted under
 * `PDVConfig.launchers.editor`. Supersedes the legacy per-language
 * `pythonEditorCmd` / `juliaEditorCmd` config keys.
 */
export interface EditorLauncherConfig {
  /**
   * Command used to open a single file (e.g. `"code {}"`, `"nvim {}"`).
   * `{}` is the file-path placeholder; if absent the path is appended.
   */
  fileCommand?: string;
  /**
   * Command used to open a directory (e.g. the per-kernel working
   * directory). Same `{}` placeholder convention. Consumed by the
   * "open working directory" action — see PLANNED_FEATURES.md.
   */
  dirCommand?: string;
  /**
   * Whether `fileCommand` is a TUI editor that must be wrapped in a
   * terminal. When unset, PDV auto-detects from the command's basename
   * (see {@link isTerminalEditorCommand}).
   */
  isTuiEditor?: boolean;
}

/**
 * User-configured AI-agent launcher. Persisted under
 * `PDVConfig.launchers.agent`. The agent CLI runs inside the configured
 * terminal preset, in a shell that has `cd`-ed to {@link cwd}.
 */
export interface AgentLauncherConfig {
  /**
   * Agent CLI command. Three placeholders are substituted with
   * shell-quoted absolute paths before launch:
   * - `{mcpConfig}` — the materialized `.pdv-mcp.json` (point the agent at
   *   PDV's MCP server, e.g. `claude --mcp-config {mcpConfig}`).
   * - `{projectRoot}` — the active project directory.
   * - `{workingDir}` — the active kernel's session working directory.
   */
  command?: string;
  /** Which directory the agent shell starts in. Defaults to `'project'`. */
  cwd?: "project" | "working";
}

/** Default agent command when `launchers.agent.command` is unset. */
export const DEFAULT_AGENT_COMMAND = "claude --mcp-config {mcpConfig}";

/**
 * Templates for each preset. Two placeholders are recognised:
 *
 * - `{cmd}` — splices the editor argv in as multiple argv tokens. Used by
 *   terminals that accept the command via `-e <argv…>` or `-- <argv…>`.
 * - `{cmdstr}` — replaced (as a substring inside an existing token) with
 *   the editor command rendered as an AppleScript-string-literal-escaped
 *   form of `'<arg1>' '<arg2>' …`. Used only by the macOS osascript
 *   presets, whose `do script` clause embeds a shell command as a string.
 *
 * Templates are tokenized with {@link tokenizeShellLike}, so quoted paths
 * survive correctly even in user-customised "custom" templates.
 *
 * Entries may be a single string (template applies on every platform the
 * preset is offered on) or a per-platform map. Per-platform forms matter
 * for cross-platform GUI terminals — Ghostty, Alacritty, kitty, WezTerm —
 * because their binaries live inside `.app` bundles on macOS and are
 * typically not on `$PATH`, while on Linux they're plain CLI binaries.
 * The macOS form launches through `open -na <App> --args …`, which finds
 * the bundle by name without requiring PATH membership.
 *
 * The Terminal.app and iTerm2 templates append `; exit` to the wrapped
 * command via AppleScript string concatenation, so the inner shell exits
 * when the editor quits. Whether the *window* then closes still depends
 * on the user's "When the shell exits" profile setting in Terminal.app /
 * iTerm2 preferences — PDV can't override that without rewriting the
 * user's profile. The Terminal.app template intentionally omits a separate
 * `tell application "Terminal" to activate` clause: `do script` already
 * raises the window, and an explicit `activate` was triggering a redundant
 * empty window on some configurations.
 */
type TerminalTemplateEntry = Partial<Record<NodeJS.Platform, string>>;

const TERMINAL_PRESET_TEMPLATES: Record<
  Exclude<TerminalPreset, "custom" | "none">,
  TerminalTemplateEntry
> = {
  "terminal-app": {
    darwin:
      `osascript -e 'tell application "Terminal" to do script {cmdstr} & "; exit"'`,
  },
  "iterm2": {
    // `create window … command "…"` is unreliable across iTerm2 versions and
    // can fail/crash on a complex command string. The documented-robust
    // pattern is to open a window with the default profile and `write text`
    // the command into its session — exactly how Terminal.app's `do script`
    // behaves, so the same quoting that works there works here.
    darwin:
      `osascript -e 'tell application "iTerm" to tell current session of (create window with default profile) to write text {cmdstr} & "; exit"'`,
  },
  "ghostty": {
    darwin: `open -na Ghostty --args -e {cmd}`,
    linux: `ghostty -e {cmd}`,
  },
  "alacritty": {
    darwin: `open -na Alacritty --args -e {cmd}`,
    linux: `alacritty -e {cmd}`,
  },
  "kitty": {
    darwin: `open -na kitty --args -- {cmd}`,
    linux: `kitty -- {cmd}`,
  },
  "wezterm": {
    darwin: `open -na WezTerm --args start -- {cmd}`,
    linux: `wezterm start -- {cmd}`,
  },
  "gnome-terminal": { linux: `gnome-terminal -- {cmd}` },
  // Konsole's `-e` consumes every following argument as the command to run,
  // so it must be the last option and takes no `--` separator (unlike
  // gnome-terminal / kitty / wezterm). A `--` here would be run as the program.
  "konsole": { linux: `konsole -e {cmd}` },
  "xterm": { linux: `xterm -e {cmd}` },
  "x-terminal-emulator": { linux: `x-terminal-emulator -e {cmd}` },
  "windows-terminal": { win32: `wt.exe new-tab {cmd}` },
};

/**
 * Resolve the spawn template for `preset` on `platform`. Returns the empty
 * string for `'custom'` / `'none'` (callers handle those separately) and for
 * presets that don't ship a template for the requested platform — the
 * empty-template fallback path in {@link resolveEditorSpawn} then substitutes
 * the platform's default preset.
 *
 * @param preset - Selected preset.
 * @param platform - Target platform (defaults to `process.platform`).
 * @returns Template string or empty when no template applies.
 */
function getPresetTemplate(
  preset: TerminalPreset,
  platform: NodeJS.Platform = process.platform,
): string {
  if (preset === "custom" || preset === "none") return "";
  return TERMINAL_PRESET_TEMPLATES[preset][platform] ?? "";
}

/**
 * Platform-appropriate default preset for first-launch users.
 *
 * @param platform - NodeJS platform identifier (defaults to `process.platform`).
 * @returns The preset PDV picks when no `launchers.terminal` config is set.
 */
export function defaultTerminalPreset(
  platform: NodeJS.Platform = process.platform,
): TerminalPreset {
  if (platform === "darwin") return "terminal-app";
  if (platform === "win32") return "windows-terminal";
  return "x-terminal-emulator";
}

/**
 * Detect whether a configured editor command refers to a known TUI editor
 * (vim, nvim, nano, …). Used to decide whether to apply the terminal wrap.
 *
 * @param command - Executable basename or path.
 * @returns True when `command`'s basename matches the TUI allowlist.
 */
export function isTerminalEditorCommand(command: string): boolean {
  const bin = path.basename(command).toLowerCase().replace(/\.exe$/, "");
  return TERMINAL_EDITORS.has(bin);
}

/**
 * Quote a single argv element using POSIX-shell single-quote rules, so the
 * inner shell of a launched terminal (bash, zsh, …) reconstructs the
 * original string.
 *
 * The standard escape for a single quote inside a single-quoted string is
 * `'\''` — close the literal, emit a backslash-escaped quote, reopen the
 * literal.
 *
 * @param arg - Argv element to quote.
 * @returns Single-quoted form safe to embed in a shell command line.
 */
export function posixShellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render an argv list as a single AppleScript double-quoted string literal,
 * suitable for substitution into a `do script` clause.
 *
 * Three layers of meaning interact:
 *
 * 1. The argv list must reconstruct as a valid shell command line when the
 *    terminal's inner shell parses it — so each element is wrapped with
 *    {@link posixShellQuote} and joined with spaces.
 * 2. The resulting shell command lives inside an AppleScript string literal,
 *    so backslashes and double-quotes must be escaped (`\` → `\\`,
 *    `"` → `\"`).
 * 3. The literal is wrapped in `"…"` so AppleScript recognises it as a
 *    string value.
 *
 * Order matters: escape `\` before `"`, otherwise the backslashes added in
 * step 2's `"` escaping would themselves be doubled.
 *
 * @param parts - Editor argv (command first, then args).
 * @returns AppleScript string literal including the surrounding quotes.
 */
export function escapeForAppleScriptString(parts: string[]): string {
  const shellLine = parts.map(posixShellQuote).join(" ");
  const escaped = shellLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Tokenise a template string using shell-like rules without invoking a shell.
 *
 * Supported:
 * - Whitespace separates tokens at top level.
 * - Single-quoted strings are taken literally (no escapes inside).
 * - Double-quoted strings honour `\\`, `\"`, `\$`, `` \` ``, and `\n` escapes;
 *   any other `\x` is preserved as-is to mirror POSIX double-quote semantics.
 * - A bare `\` outside quotes escapes the next character (so a path can
 *   contain a literal space without quoting) — **except on Windows**, where
 *   `\` is a path separator and is treated as a literal character. Windows
 *   users quote paths containing spaces with `"…"` instead.
 *
 * Not supported (out of scope — templates are static or user-typed, not
 * generated by a shell): variable expansion, command substitution, globs,
 * here-documents, redirections.
 *
 * @param template - Template string from the preset table or user input.
 * @param platform - Target platform; governs whether a bare `\` escapes the
 *   next character. Defaults to `process.platform`.
 * @returns Argv-style token list.
 * @throws {Error} If a quote is left unterminated.
 */
export function tokenizeShellLike(
  template: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const backslashEscapes = platform !== "win32";
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        cur += c;
      }
      hasToken = true;
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
      } else if (c === "\\" && i + 1 < template.length) {
        const n = template[i + 1];
        if (n === '"' || n === "\\" || n === "$" || n === "`" || n === "\n") {
          cur += n;
          i++;
        } else {
          cur += c;
        }
      } else {
        cur += c;
      }
      hasToken = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (backslashEscapes && c === "\\" && i + 1 < template.length) {
      cur += template[i + 1];
      i++;
      hasToken = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += c;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    throw new Error(`Unterminated quote in terminal template: ${template}`);
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

/**
 * Expand a terminal-preset template into a spawn-ready `{ file, args }`.
 *
 * The template is tokenised first (so user-customised templates with quoted
 * paths survive). Then each token is processed:
 *
 * - Token exactly `{cmd}` → spliced as `command, ...args` (multiple tokens).
 * - Token containing `{cmdstr}` as a substring → that substring is replaced
 *   with {@link escapeForAppleScriptString}'s output (a single AppleScript
 *   string literal). Surrounding text in the same token is preserved.
 * - All other tokens pass through verbatim.
 *
 * @param template - Preset or custom template string.
 * @param command - Editor executable.
 * @param args - Editor argv (path, flags, …).
 * @param platform - Target platform, forwarded to {@link tokenizeShellLike}
 *   so backslash handling matches the OS. Defaults to `process.platform`.
 * @returns Spawn-ready file + args. Throws if the template is empty or
 *   produces no tokens.
 */
export function expandTerminalTemplate(
  template: string,
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  const tokens = tokenizeShellLike(template, platform);
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok === "{cmd}") {
      out.push(command, ...args);
    } else if (tok.includes("{cmdstr}")) {
      out.push(tok.replace(/\{cmdstr\}/g, escapeForAppleScriptString([command, ...args])));
    } else {
      out.push(tok);
    }
  }
  if (out.length === 0) {
    throw new Error(`Terminal template produced no tokens: ${template}`);
  }
  return { file: out[0], args: out.slice(1) };
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
 * Whether to wrap the command in a terminal is governed by
 * `opts.wrapInTerminal`. The caller passes the user's
 * `launchers.editor.isTuiEditor` flag straight through: when it is `true`
 * the spec is wrapped, when `false` it is left bare, and when `undefined`
 * (the user has expressed no preference) PDV auto-detects from the
 * command's basename via {@link isTerminalEditorCommand}.
 *
 * When `opts.terminal` is unset, the platform-default preset is used (see
 * {@link defaultTerminalPreset}) — preserves PDV's prior macOS-Terminal.app
 * behaviour for users who never touch the new setting, and gives Linux a
 * working `x-terminal-emulator` default where there used to be no wrapper
 * at all.
 *
 * `preset: 'none'` is a deliberate opt-out: it returns the spec unwrapped
 * even for a TUI editor. Spawning `vim` without a TTY won't open a usable
 * window — the setting is intended for GUI editors that PDV's allowlist
 * misclassifies (e.g. `nvim-qt`, custom shims). A warning is logged when
 * this combination is hit.
 *
 * @param command - Editor executable.
 * @param args - Editor arguments.
 * @param opts - Optional launcher configuration:
 *   - `wrapInTerminal` — force terminal wrapping on/off; auto-detected when
 *     omitted.
 *   - `terminal` — terminal-emulator preset selection.
 *   - `platform` — defaults to `process.platform`; lets tests exercise
 *     platform-specific templates without monkey-patching globals.
 * @returns Spawn-ready executable and argument list.
 */
export function resolveEditorSpawn(
  command: string,
  args: string[],
  opts?: {
    wrapInTerminal?: boolean;
    terminal?: TerminalLauncherConfig;
    platform?: NodeJS.Platform;
  },
): { file: string; args: string[] } {
  const wrapInTerminal = opts?.wrapInTerminal ?? isTerminalEditorCommand(command);
  if (!wrapInTerminal) {
    return { file: command, args };
  }

  const platform = opts?.platform ?? process.platform;
  const preset = opts?.terminal?.preset ?? defaultTerminalPreset(platform);

  if (preset === "none") {
    console.warn(
      `[pdv] launching TUI editor "${command}" without a terminal wrapper ` +
        `(launchers.terminal.preset='none'). It likely will not open a usable window.`,
    );
    return { file: command, args };
  }

  const template =
    preset === "custom"
      ? (opts?.terminal?.customTemplate ?? "").trim()
      : getPresetTemplate(preset, platform);

  if (!template) {
    // Fall back to the platform default rather than silently dropping the
    // wrapper for a TUI editor. Two distinct causes, distinguished in the
    // log so the user can tell which applies to them.
    const fallback = defaultTerminalPreset(platform);
    const reason =
      preset === "custom"
        ? `preset='custom' but customTemplate is empty`
        : `preset='${preset}' has no template for platform '${platform}'`;
    console.warn(
      `[pdv] launchers.terminal ${reason}; falling back to '${fallback}'.`,
    );
    return expandTerminalTemplate(
      getPresetTemplate(fallback, platform),
      command,
      args,
      platform,
    );
  }

  return expandTerminalTemplate(template, command, args, platform);
}
