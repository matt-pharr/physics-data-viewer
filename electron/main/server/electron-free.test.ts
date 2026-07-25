/**
 * electron-free.test.ts — Guards on server-destined files: no Electron
 * imports, no direct stdout writes.
 *
 * Every `electron` import has been removed from the files that run in the
 * pdv-server process; this test keeps them out. It reads each file in
 * {@link SERVER_DESTINED_FILES} from disk and fails on any static import,
 * `import type`, or `require` of the `electron` module — a reintroduced
 * coupling should fail here, not at runtime in the extracted process.
 *
 * It also forbids direct `process.stdout` access: in the pdv-server,
 * stdout is the RPC protocol channel, and a raw write there corrupts
 * frame framing (`console.*` is safe — server-main rebinds it to stderr
 * as its first statement). The transport's line codec is the one
 * sanctioned writer, via the stream handed to it — not `process.stdout`
 * by name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SERVER_DESTINED_FILES } from "./server-files";

const MAIN_DIR = path.resolve(__dirname, "..");

/** Matches static imports, type-only imports, and requires of electron. */
const ELECTRON_IMPORT_RE =
  /(?:from\s+["']electron["'])|(?:require\(\s*["']electron["']\s*\))|(?:import\s*\(\s*["']electron["']\s*\))/;

/**
 * Matches direct process.stdout access. `server-main.ts` is the one file
 * allowed to name it (it hands the stream to the transport).
 */
const STDOUT_ACCESS_RE = /process\.stdout/;
const STDOUT_ALLOWED = new Set(["server/server-main.ts"]);

/**
 * Matches any reach into the shell-only remote layer.
 *
 * `main/remote/` drives the *client* side of an ssh connection and depends
 * on node-pty, a native module built for this machine. The pdv-server runs
 * as plain Node on the remote host, where no such binary exists — and where
 * the concept makes no sense anyway, since the server is the far end of the
 * connection rather than the thing establishing it.
 */
const REMOTE_IMPORT_RE = /["'](?:\.\.?\/)*remote\/[a-z-]+["']|["']node-pty["']/;

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

  it.each([...SERVER_DESTINED_FILES])(
    "%s does not pull in the shell-only remote/ssh layer",
    (rel) => {
      const source = fs.readFileSync(path.join(MAIN_DIR, rel), "utf8");
      const offending = source
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => REMOTE_IMPORT_RE.test(line));
      expect(offending).toEqual([]);
    },
  );

  it.each([...SERVER_DESTINED_FILES])(
    "%s never writes to process.stdout (protocol channel)",
    (rel) => {
      if (STDOUT_ALLOWED.has(rel)) return;
      const source = fs.readFileSync(path.join(MAIN_DIR, rel), "utf8");
      const offending = source
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => STDOUT_ACCESS_RE.test(line));
      expect(offending).toEqual([]);
    },
  );
});
