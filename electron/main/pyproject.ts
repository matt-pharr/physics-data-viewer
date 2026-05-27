/**
 * pyproject.ts — Generate and read a project's `pyproject.toml`.
 *
 * `generatePyproject` produces a fresh PEP 621 manifest for new uv projects
 * (ARCHITECTURE.md §10.5.8). `parseDependencies` reads `[project].dependencies`
 * for the Packages UI (§10.5.13).
 *
 * PDV does not WRITE to an existing `pyproject.toml` directly — every
 * mutation goes through `uv add` / `uv remove`, which preserves user-authored
 * fields and re-locks atomically (§10.5.4).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §10.5.8, §10.5.13, §10.5.14
 */

// `smol-toml` is published as an ES module; the main process is CommonJS, so
// we load it via a dynamic `import()` rather than a static import.
async function _loadTomlParse(): Promise<(text: string) => unknown> {
  const mod = await import("smol-toml");
  return mod.parse;
}

/** Options for {@link generatePyproject}. */
export interface GeneratePyprojectOptions {
  /** Direct dependencies as PEP 508 specs. */
  dependencies: string[];
  /** Project name (PEP 621 `name`). Defaults to `"pdv-project"`. */
  name?: string;
  /** `requires-python` constraint. Defaults to `">=3.10"`. */
  requiresPython?: string;
}

/**
 * Quote a value as a TOML basic string. JSON quoting covers the escapes
 * (`"`, `\`, control chars) that TOML basic strings and JSON strings share,
 * which is sufficient for project names and PEP 508 dependency specs.
 *
 * @param value - The raw string value.
 * @returns The double-quoted, escaped TOML string literal.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Generate a minimal PEP 621 `pyproject.toml` for a new uv project.
 *
 * `pdv-python` is intentionally NOT listed here — it is app-managed and
 * installed into the venv separately (§10.5.7).
 *
 * @param options - Project name, dependencies, and python constraint.
 * @returns The `pyproject.toml` file contents.
 */
export function generatePyproject(options: GeneratePyprojectOptions): string {
  const name = options.name ?? "pdv-project";
  const requiresPython = options.requiresPython ?? ">=3.10";
  const deps = options.dependencies;
  const depBlock =
    deps.length === 0
      ? "dependencies = []"
      : `dependencies = [\n${deps.map((d) => `    ${tomlString(d)},`).join("\n")}\n]`;
  return (
    `[project]\n` +
    `name = ${tomlString(name)}\n` +
    `version = "0.1.0"\n` +
    `requires-python = ${tomlString(requiresPython)}\n` +
    `${depBlock}\n`
  );
}

/**
 * Read the `[project].dependencies` array from a `pyproject.toml` source.
 *
 * Returns an empty list when the file is unparseable or the field is absent
 * or malformed — the Packages UI degrades gracefully rather than throwing.
 *
 * @param pyprojectText - Raw contents of a `pyproject.toml` file.
 * @returns The PEP 508 specs declared in `[project].dependencies`, in order.
 */
export async function parseDependencies(pyprojectText: string): Promise<string[]> {
  let toml: Record<string, unknown>;
  try {
    const parse = await _loadTomlParse();
    toml = parse(pyprojectText) as Record<string, unknown>;
  } catch {
    return [];
  }
  const project = toml.project as Record<string, unknown> | undefined;
  const deps = project?.dependencies;
  if (!Array.isArray(deps)) return [];
  return deps.filter((d): d is string => typeof d === "string");
}

/**
 * Normalize a distribution name per PEP 503 (lowercase, runs of `-_.`
 * collapsed to `-`). Used to match a PEP 508 spec name against a
 * `uv pip list` entry's name.
 *
 * @param name - Raw distribution or spec name (e.g. `"Numpy_Test"`).
 * @returns The normalized name (e.g. `"numpy-test"`).
 */
export function normalizeDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Extract the distribution name from a PEP 508 specifier.
 *
 * @param spec - A PEP 508 spec like `"scipy>=1.10"` or `"pkg[extra]>=1.0"`.
 * @returns The normalized distribution name.
 */
export function specName(spec: string): string {
  const head = spec.split(/[<>=!~\[; ]/, 1)[0]?.trim() ?? "";
  return normalizeDistName(head);
}
