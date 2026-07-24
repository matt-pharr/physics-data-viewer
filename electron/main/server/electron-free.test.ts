/**
 * electron-free.test.ts — Guard: server-destined files import no Electron.
 *
 * Every `electron` import has been removed from the files that will move
 * into the pdv-server process; this test keeps them out. It reads each
 * file in {@link SERVER_DESTINED_FILES} from disk and fails on any static
 * import, `import type`, or `require` of the `electron` module — a
 * reintroduced coupling should fail here, not when the process split lands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SERVER_DESTINED_FILES } from "./server-files";

const MAIN_DIR = path.resolve(__dirname, "..");

/** Matches static imports, type-only imports, and requires of electron. */
const ELECTRON_IMPORT_RE =
  /(?:from\s+["']electron["'])|(?:require\(\s*["']electron["']\s*\))|(?:import\s*\(\s*["']electron["']\s*\))/;

describe("server-destined files are Electron-free", () => {
  it("every listed file exists (list is not stale)", () => {
    const missing = SERVER_DESTINED_FILES.filter(
      (rel) => !fs.existsSync(path.join(MAIN_DIR, rel)),
    );
    expect(missing).toEqual([]);
  });

  it.each([...SERVER_DESTINED_FILES])("%s has no electron import", (rel) => {
    const source = fs.readFileSync(path.join(MAIN_DIR, rel), "utf8");
    const offending = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => ELECTRON_IMPORT_RE.test(line));
    expect(offending).toEqual([]);
  });
});
