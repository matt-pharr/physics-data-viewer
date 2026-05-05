/**
 * constants.ts — Named constants for magic numbers used across the renderer.
 *
 * Centralises tuneable values so they are discoverable and documented in one place.
 */

/** Maximum number of cell undo snapshots retained. */
export const CELL_UNDO_LIMIT = 20;

/** Debounce delay (ms) for code-cell persistence writes. */
export const CODE_CELL_SAVE_DEBOUNCE_MS = 500;

/** Default namespace auto-refresh interval (ms). */
export const NAMESPACE_REFRESH_INTERVAL_MS = 2000;

/** Maximum recent projects to retain. */
export const MAX_RECENT_PROJECTS = 10;

/** Maximum console log entries before oldest are dropped. */
export const MAX_LOG_ENTRIES = 2000;

/**
 * Fallback autosave interval (s) when no config value is present. Should
 * match `DEFAULT_AUTOSAVE_INTERVAL_S` in `electron/main/config.ts` — kept in
 * sync manually because the renderer can't import from main.
 */
export const DEFAULT_AUTOSAVE_INTERVAL_S = 300;
