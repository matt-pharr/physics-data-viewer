/**
 * julia-versions.ts — Supported Julia version range for PDV projects.
 *
 * Single source of truth for the Julia minors the New Julia Project dialog
 * offers and `kernels.start` accepts for pkg-mode projects (§10.6.5) — the
 * Julia sibling of `python-versions.ts`. The floor must track the `julia`
 * compat bound in `pdv-julia/Project.toml`; the ceiling is the newest minor
 * PDVKernel is tested against.
 *
 * This file does NOT probe runtimes or talk to juliaup — it is pure
 * constants, safe to import from both the main process and the preload
 * script (re-exposed to the renderer as static values under
 * `window.pdv.system`).
 */

/**
 * Julia minor versions supported for pkg-mode PDV projects, oldest first.
 * Keep in sync with `julia = "1.10"` in pdv-julia/Project.toml.
 */
export const SUPPORTED_JULIA_VERSIONS: readonly string[] = [
  "1.10",
  "1.11",
  "1.12",
];

/**
 * Default Julia version preselected in the New Julia Project dialog when no
 * juliaup default channel provides a supported minor. One behind the newest
 * supported release so the package ecosystem is reliably compatible.
 */
export const DEFAULT_JULIA_VERSION = "1.11";
