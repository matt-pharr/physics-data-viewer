/**
 * test-pdv-version.ts — single source for the PDV version in renderer test
 * fixtures. Derives from electron/package.json so a version bump doesn't
 * have to touch every test file (see issue #235).
 *
 * @see electron/main/test-helpers.ts — exports `TEST_PDV_VERSION` and
 *      `TEST_PDV_VERSION_TEST_SUFFIX` for main-process tests. We can't share
 *      one TS module across the main↔renderer tsconfig boundary, but both
 *      derive from the same `electron/package.json`.
 */
import pkg from "../../../package.json";

/** Canonical PDV version, e.g. `"0.1.2"`. */
export const TEST_PDV_VERSION: string = pkg.version;
