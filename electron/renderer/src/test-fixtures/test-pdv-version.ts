/**
 * test-pdv-version.ts — single source for the PDV version in renderer test
 * fixtures. Derives from electron/package.json so a version bump doesn't
 * have to touch every test file (see issue #235). The main-process tests
 * import the equivalent constant from electron/main/test-helpers.ts; we
 * can't share one TS module across the process boundary, but both derive
 * from the same package.json.
 */
import pkg from "../../../package.json";

/** Canonical PDV version, e.g. `"0.1.2"`. */
export const TEST_PDV_VERSION: string = pkg.version;
