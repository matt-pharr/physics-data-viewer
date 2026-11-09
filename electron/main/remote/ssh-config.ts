/**
 * ssh-config.ts — Harvest host alias names from the user's `~/.ssh/config`.
 *
 * This file exists for exactly one reason: to populate the host picker with
 * the names the user already types after `ssh`. It is NOT an implementation
 * of ssh_config semantics and must never become one — `ssh` itself remains
 * the sole authority on how a connection is actually made. PDV passes an
 * alias through to the `ssh` binary verbatim and lets it resolve HostName,
 * User, Port, ProxyCommand, IdentityAgent and the rest.
 *
 * That split is what makes the lenience here safe. A pattern this parser
 * misreads costs the user an entry missing from a dropdown, not a broken or
 * (worse) subtly wrong connection: free-text host entry is always available
 * as the escape hatch, and a hand-typed alias takes the identical code path.
 *
 * Responsibilities
 * - Read the user config and any files it pulls in via `Include`.
 * - Collect the concrete alias names declared by `Host` lines, in the order
 *   they appear, along with `HostName`/`User` purely as display hints.
 * - Survive anything: unreadable files, cyclic includes, unknown keywords,
 *   `Match` blocks, and syntax this parser does not model.
 *
 * What it does NOT do
 * - Resolve what an alias means. No pattern matching against a target host,
 *   no `Host *` inheritance, no option precedence, no percent expansion.
 * - Decide connection behaviour. Nothing here feeds the `ssh` argv beyond
 *   the alias name the user picked.
 * - Touch the filesystem outside the config's own include graph, or write
 *   anything at all.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.7
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

/** Default cap on `Include` nesting depth (cycle/runaway guard). */
const DEFAULT_MAX_INCLUDE_DEPTH = 8;

/** Hard cap on how many config files one harvest will read. */
const MAX_FILES = 64;

/**
 * A concrete host alias declared in the ssh config.
 *
 * `hostName`/`user` are display hints only — they are read from the same
 * `Host` block without applying inheritance, so a block that relies on a
 * `Host *` default will report them as null. Never use them to build a
 * connection; pass {@link SshHostAlias.alias} to `ssh` instead.
 */
export interface SshHostAlias {
  /** The alias as written, e.g. `flux`. */
  alias: string;
  /** `HostName` declared in the same block, or null when absent. */
  hostName: string | null;
  /** `User` declared in the same block, or null when absent. */
  user: string | null;
  /** Absolute path of the config file that declared it. */
  source: string;
}

/** Options for {@link listSshHostAliases}. */
export interface ListSshHostAliasesOptions {
  /** Config file to start from. Defaults to `<homeDir>/.ssh/config`. */
  configPath?: string;
  /** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Maximum `Include` nesting depth. Defaults to {@link DEFAULT_MAX_INCLUDE_DEPTH}. */
  maxIncludeDepth?: number;
}

/** One parsed directive: a lowercased keyword and its raw argument text. */
interface Directive {
  keyword: string;
  value: string;
}

/**
 * Split a config line into keyword and argument text.
 *
 * ssh accepts `Keyword value`, `Keyword=value` and `Keyword = value`, with
 * arbitrary leading whitespace and `#` comments on their own lines.
 *
 * @param line - A single raw line from a config file.
 * @returns The directive, or null for blank/comment/unparseable lines.
 */
function parseDirective(line: string): Directive | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (!match) return null;
  const value = match[2].trim();
  if (!value) return null;
  return { keyword: match[1].toLowerCase(), value };
}

/**
 * Split a directive's argument text into whitespace-separated tokens,
 * honouring double quotes (`Host "my host" other`).
 *
 * @param value - Raw argument text.
 * @returns The tokens, with surrounding quotes removed.
 */
function splitArguments(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const token = match[1] ?? match[2];
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Whether a `Host` token is a concrete alias rather than a pattern.
 *
 * Patterns (`*`, `foo?`, `!bar`) match hosts, they do not name one, so
 * offering them in a picker would produce a connection to nowhere.
 *
 * @param token - A single token from a `Host` line.
 * @returns True when the token can be handed to `ssh` as a destination.
 */
function isConcreteAlias(token: string): boolean {
  return !/[*?!]/.test(token);
}

/**
 * Expand a leading `~` to the given home directory.
 *
 * @param target - A path that may begin with `~`.
 * @param homeDir - Home directory to substitute.
 * @returns The expanded path (unchanged when there is no leading `~`).
 */
function expandTilde(target: string, homeDir: string): string {
  if (target === "~") return homeDir;
  if (target.startsWith("~/")) return path.join(homeDir, target.slice(2));
  return target;
}

/**
 * Convert a glob pattern into an anchored regular expression.
 *
 * Only `*` and `?` are modelled — the wildcards that appear in real
 * `Include` lines (`config.d/*`, `*.conf`). Anything else is matched
 * literally.
 *
 * @param pattern - The basename pattern to convert.
 * @returns A RegExp anchored to the whole basename.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/**
 * Resolve one `Include` argument to a list of concrete file paths.
 *
 * Relative paths resolve against `~/.ssh`, matching ssh's behaviour for a
 * user config. Globs are supported in the final path segment only, which
 * covers the shapes that occur in practice (`config.d/*`); a glob earlier in
 * the path is treated literally and simply resolves to nothing.
 *
 * @param arg - A single `Include` argument.
 * @param homeDir - Home directory for `~` expansion and the `.ssh` default.
 * @returns Absolute paths of files to read, in sorted order. Empty when the
 *   pattern matches nothing or the directory cannot be listed.
 */
async function resolveIncludeArgument(
  arg: string,
  homeDir: string,
): Promise<string[]> {
  const expanded = expandTilde(arg, homeDir);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.join(homeDir, ".ssh", expanded);

  const base = path.basename(absolute);
  if (!/[*?]/.test(base)) {
    return [absolute];
  }

  const dir = path.dirname(absolute);
  const matcher = globToRegExp(base);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.isDirectory() && matcher.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    // An unreadable or missing include directory is normal (the OrbStack
    // include at the top of a default config points at a file that may not
    // exist yet). It costs the picker some entries, nothing more.
    return [];
  }
}

/** Mutable state threaded through the recursive file walk. */
interface HarvestState {
  homeDir: string;
  maxDepth: number;
  /** Absolute paths already read, so a cyclic include terminates. */
  visited: Set<string>;
  /** Aliases in declaration order, first declaration winning. */
  found: Map<string, SshHostAlias>;
}

/**
 * Read one config file and fold its aliases into the harvest state.
 *
 * @param filePath - Absolute path of the file to read.
 * @param depth - Current include depth (0 for the top-level config).
 * @param state - Shared harvest state, mutated in place.
 * @returns Nothing. Unreadable files are skipped silently by design.
 */
async function harvestFile(
  filePath: string,
  depth: number,
  state: HarvestState,
): Promise<void> {
  if (depth > state.maxDepth) return;
  const resolved = path.resolve(filePath);
  if (state.visited.has(resolved)) return;
  if (state.visited.size >= MAX_FILES) return;
  state.visited.add(resolved);

  let text: string;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch {
    // Missing or unreadable: the config may reference files that do not
    // exist, and a permissions error must not take the picker down.
    return;
  }

  // Aliases declared by the `Host` block currently in scope. Null means no
  // Host block is open — either we have not seen one yet, or a `Match` block
  // took over, and any HostName/User we read now belongs to neither.
  let openAliases: string[] | null = null;

  for (const line of text.split(/\r?\n/)) {
    const directive = parseDirective(line);
    if (!directive) continue;

    switch (directive.keyword) {
      case "host": {
        openAliases = splitArguments(directive.value).filter(isConcreteAlias);
        for (const alias of openAliases) {
          if (state.found.has(alias)) continue;
          state.found.set(alias, {
            alias,
            hostName: null,
            user: null,
            source: resolved,
          });
        }
        break;
      }

      case "match": {
        openAliases = null;
        break;
      }

      case "hostname":
      case "user": {
        if (!openAliases) break;
        const [value] = splitArguments(directive.value);
        if (!value) break;
        const field = directive.keyword === "hostname" ? "hostName" : "user";
        for (const alias of openAliases) {
          const entry = state.found.get(alias);
          // Only fill a hint that is still empty: when an alias is declared
          // twice, the first block wins, matching ssh's first-wins rule for
          // options (even though we do not implement that rule generally).
          if (entry && entry[field] === null) {
            entry[field] = value;
          }
        }
        break;
      }

      case "include": {
        for (const arg of splitArguments(directive.value)) {
          const targets = await resolveIncludeArgument(arg, state.homeDir);
          for (const target of targets) {
            await harvestFile(target, depth + 1, state);
          }
        }
        break;
      }

      default:
        break;
    }
  }
}

/**
 * List the concrete host aliases declared in the user's ssh config.
 *
 * Never throws: a missing, unreadable or malformed config yields an empty or
 * partial list, because the host picker always offers free-text entry and a
 * typed alias reaches `ssh` by the same path as a picked one.
 *
 * @param options - Overrides for the config path, home directory and include depth.
 * @returns Aliases in declaration order, deduplicated by name (first wins).
 */
export async function listSshHostAliases(
  options: ListSshHostAliasesOptions = {},
): Promise<SshHostAlias[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = options.configPath ?? path.join(homeDir, ".ssh", "config");
  const state: HarvestState = {
    homeDir,
    maxDepth: options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH,
    visited: new Set<string>(),
    found: new Map<string, SshHostAlias>(),
  };
  await harvestFile(configPath, 0, state);
  return [...state.found.values()];
}
