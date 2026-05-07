/**
 * vite-env.d.ts — Vite ambient type augmentation entrypoint.
 *
 * Keeps standard Vite client typings available in renderer TypeScript builds.
 */

/// <reference types="vite/client" />

/** Short git SHA captured at build time. Surfaced in the About tab. */
declare const __BUILD_SHA__: string;

/** ISO-8601 timestamp captured when the renderer bundle was built. */
declare const __BUILD_TIME__: string;
