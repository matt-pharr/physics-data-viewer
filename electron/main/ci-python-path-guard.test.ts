/**
 * ci-python-path-guard.test.ts — CI sentinel for the @slow kernel suites.
 *
 * The @slow files (integration.test.ts, kernel-manager*.test.ts) are excluded
 * from collection when PYTHON_PATH is unset — see vitest.config.ts. That keeps
 * `npm test` fast for local devs without a Python toolchain, but it also means
 * a CI misconfiguration that drops PYTHON_PATH would make those suites vanish
 * with a still-green run (no skip marker, no failure — they simply aren't
 * collected). This sentinel is always collected (it is NOT a @slow file) and
 * fails loudly in that case, so kernel/integration coverage can't evaporate
 * unnoticed.
 */

import { describe, expect, it } from "vitest";

describe("CI kernel-suite guard", () => {
  it("requires PYTHON_PATH in CI so the @slow kernel suites are collected", () => {
    // Local runs opt into the @slow suites by setting PYTHON_PATH themselves;
    // only CI is required to have it. GitHub Actions sets CI=true.
    if (!process.env.CI) return;
    expect(
      process.env.PYTHON_PATH,
      "PYTHON_PATH must be set in CI so the @slow kernel/integration suites are " +
        "collected (see vitest.config.ts). Without it they are silently excluded " +
        "and their coverage vanishes with a green run.",
    ).toBeTruthy();
  });
});
