/**
 * npm-scripts.test.ts — Every `./node_modules/...` path in package.json's
 * scripts must actually exist.
 *
 * The scripts invoke tools by explicit path (`node
 * ./node_modules/vite/bin/vite.js`) rather than through `npm exec` or the
 * `.bin` shims. That is deliberate — it avoids PATH surprises and makes each
 * script say exactly what it runs — but it hard-codes a package's internal
 * layout, which is not something a package promises to keep stable.
 *
 * That bit for real: a dependency bump moved `concurrently`'s entry point
 * from `dist/bin/concurrently.js` to `dist/bin/index.js`, and `npm run dev`
 * died with `Cannot find module`. Nothing caught it — the tests, typecheck,
 * lint, and even the packaged build all pass without ever running the dev
 * script, so it stayed broken until someone tried to develop.
 *
 * This is the cheap half of the guard: it runs in the normal unit suite and
 * catches a stale path the moment a bump lands. The CI `dev-smoke` job is
 * the other half, actually booting the thing.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const ELECTRON_ROOT = path.resolve(__dirname, "..");

const { scripts } = JSON.parse(
  fs.readFileSync(path.join(ELECTRON_ROOT, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

/** Every `./node_modules/...` path referenced by a script, with its script name. */
const referenced: Array<{ script: string; target: string }> = Object.entries(scripts).flatMap(
  ([script, command]) =>
    (command.match(/\.\.?\/node_modules\/[^\s"';|&]+/g) ?? []).map((target) => ({
      script,
      target,
    })),
);

describe("package.json scripts", () => {
  it("reference at least one tool by explicit path (guard is not vacuous)", () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  it.each(referenced)("$script → $target exists", ({ target }) => {
    // `../node_modules/...` appears in scripts that `cd renderer` first, so
    // resolve both spellings against the electron root.
    const resolved = path.resolve(ELECTRON_ROOT, target.replace(/^\.\.\//, "./"));
    expect(
      fs.existsSync(resolved),
      `${target} does not exist — a dependency bump probably moved it. ` +
        "Update the script to the package's current entry point.",
    ).toBe(true);
  });
});
