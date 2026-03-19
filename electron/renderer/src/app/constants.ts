/**
 * constants.ts — Named constants for magic numbers used across the renderer.
 *
 * Centralises tuneable values so they are discoverable and documented in one place.
 */

/** Maximum number of cell undo snapshots retained. */
export const CELL_UNDO_LIMIT = 20;

/** Debounce delay (ms) for code-cell persistence writes. */
export const CODE_CELL_SAVE_DEBOUNCE_MS = 500;

/** Debounce delay (ms) for tree expanded-paths persistence. */
export const TREE_PERSIST_DEBOUNCE_MS = 500;

/** Default namespace auto-refresh interval (ms). */
export const NAMESPACE_REFRESH_INTERVAL_MS = 2000;

/** Maximum recent projects to retain. */
export const MAX_RECENT_PROJECTS = 10;
