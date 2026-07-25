/**
 * server-paths.ts — Injected filesystem locations for server-destined code.
 *
 * Server-side code (kernel/environment registrars, uv/julia discovery,
 * module-manager) needs two locations that were previously read from
 * Electron globals: the per-user app-data directory (`app.getPath("userData")`)
 * and the packaged-resources root (`process.resourcesPath`). Server code
 * cannot touch either, so both are injected here once at startup:
 *
 * In production the values arrive purely as environment variables: the
 * shell's `server-supervisor.ts` sets `PDV_USER_DATA_DIR` and
 * `PDV_RESOURCES_ROOT` when it spawns the server, and the getters below
 * read them directly — no init call is involved. {@link initServerPaths}
 * exists for tests that need to point this module at a temp directory.
 *
 * This module does NOT create directories or validate that the paths exist —
 * callers keep their existing existence checks (a missing resources root is
 * normal in dev runs).
 */

/** Injected path values. */
interface ServerPathsState {
  /** Per-user app-data directory (Electron `userData`). */
  userDataDir: string | null;
  /** Packaged-resources root (`process.resourcesPath`), or null unpackaged. */
  resourcesRoot: string | null;
}

const state: ServerPathsState = {
  userDataDir: null,
  resourcesRoot: null,
};

/**
 * Inject the server path roots. Call once at process startup, before any
 * invoke handler runs; calling again replaces the values (harmless on the
 * macOS window-recreate path, which re-runs bootstrap wiring).
 *
 * @param paths - The resolved locations. `resourcesRoot` may be null when
 *   running unpackaged.
 * @returns Nothing.
 */
export function initServerPaths(paths: {
  userDataDir: string;
  resourcesRoot: string | null;
}): void {
  state.userDataDir = paths.userDataDir;
  state.resourcesRoot = paths.resourcesRoot;
}

/**
 * The per-user app-data directory (Electron's `userData` path).
 *
 * @returns The injected directory, or the `PDV_USER_DATA_DIR` environment
 *   variable when no init has run.
 * @throws Error when neither an injected value nor the environment variable
 *   is available — server code must never guess at a writable location.
 */
export function getUserDataDir(): string {
  const dir = state.userDataDir ?? process.env.PDV_USER_DATA_DIR;
  if (!dir) {
    throw new Error(
      "Server paths not initialized: no userData dir (call initServerPaths " +
        "or set PDV_USER_DATA_DIR)"
    );
  }
  return dir;
}

/**
 * The packaged-resources root (`process.resourcesPath` in the shell).
 *
 * @returns The injected root, the `PDV_RESOURCES_ROOT` environment variable,
 *   or null when running unpackaged — callers already treat null as "no
 *   packaged resources" and fall through to their dev-tree lookups.
 */
export function getResourcesRoot(): string | null {
  return state.resourcesRoot ?? process.env.PDV_RESOURCES_ROOT ?? null;
}
