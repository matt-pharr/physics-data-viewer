/**
 * pyproject.ts — Generate a project's `pyproject.toml`.
 *
 * For now this only *generates* a fresh PEP 621 manifest for a new uv
 * project (ARCHITECTURE.md §10.5.8). Reading and round-tripping an existing
 * `pyproject.toml` without clobbering user-authored fields (§10.5.4) needs a
 * real TOML library and lands with the Packages UI (§10.5.13).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §10.5.8 (new project flow), §10.5.14 (default packages)
 */

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
