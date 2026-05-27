/**
 * generation-guard.test.ts — Unit tests for the MCP generation-bump predicate.
 *
 * Locks in the contract that:
 *  - first set (null -> X) does not bump (the agent has not seen anything yet)
 *  - re-assertion (X -> X) does not bump (e.g. `project:save` re-asserting
 *    the same `saveDir` after every save) — this is the regression PR #291
 *    was opened to fix
 *  - real change (X -> Y, X -> null) bumps
 */

import { describe, expect, it } from "vitest";

import { shouldBumpOnSwap } from "./generation-guard";

describe("shouldBumpOnSwap", () => {
  it("does not bump on the initial null -> X assignment", () => {
    expect(shouldBumpOnSwap(null, "/proj/a")).toBe(false);
    expect(shouldBumpOnSwap(null, null)).toBe(false);
  });

  it("does not bump when re-asserting the same value (project:save pattern)", () => {
    expect(shouldBumpOnSwap("/proj/a", "/proj/a")).toBe(false);
    expect(shouldBumpOnSwap("kernel-1", "kernel-1")).toBe(false);
  });

  it("bumps when the value actually changes between two set values", () => {
    expect(shouldBumpOnSwap("/proj/a", "/proj/b")).toBe(true);
    expect(shouldBumpOnSwap("kernel-1", "kernel-2")).toBe(true);
  });

  it("bumps when transitioning from a set value to null (project close)", () => {
    expect(shouldBumpOnSwap("/proj/a", null)).toBe(true);
    expect(shouldBumpOnSwap("kernel-1", null)).toBe(true);
  });
});
