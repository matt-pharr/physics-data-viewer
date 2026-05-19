/**
 * tools/_helpers.test.ts — Unit tests for the mutating-tier gate helpers
 * (`assertMutatingToolsEnabled` / `assertPdvRunEnabled`) and the related
 * `requireKernel` shape implicit in `kernelMutate`.
 */

import { describe, expect, it } from "vitest";

import type { McpToolContext } from "../mcp-context";
import {
  assertMutatingToolsEnabled,
  assertPdvRunEnabled,
} from "./_helpers";

/** Minimal context exposing only the configStore needed by the gate helpers. */
function makeCtx(mcp: Record<string, unknown> | undefined): McpToolContext {
  return {
    configStore: {
      get: (key: string) => (key === "mcp" ? mcp : undefined),
    },
  } as unknown as McpToolContext;
}

describe("assertMutatingToolsEnabled", () => {
  it("returns silently when `mutatingToolsEnabled` is true", () => {
    expect(() =>
      assertMutatingToolsEnabled(makeCtx({ mutatingToolsEnabled: true })),
    ).not.toThrow();
  });

  it("throws when the toggle is missing entirely (default off)", () => {
    expect(() => assertMutatingToolsEnabled(makeCtx(undefined))).toThrow(
      /disabled/i,
    );
    expect(() => assertMutatingToolsEnabled(makeCtx({}))).toThrow(/disabled/i);
  });

  it("throws when the toggle is explicitly false", () => {
    expect(() =>
      assertMutatingToolsEnabled(makeCtx({ mutatingToolsEnabled: false })),
    ).toThrow(/Settings → Agents/);
  });
});

describe("assertPdvRunEnabled", () => {
  it("returns silently when `pdvRunEnabled` is true", () => {
    expect(() =>
      assertPdvRunEnabled(makeCtx({ pdvRunEnabled: true })),
    ).not.toThrow();
  });

  it("throws when the toggle is missing or false", () => {
    expect(() => assertPdvRunEnabled(makeCtx(undefined))).toThrow(
      /pdv_run.*disabled/i,
    );
    expect(() => assertPdvRunEnabled(makeCtx({ pdvRunEnabled: false }))).toThrow(
      /pdv_run.*disabled/i,
    );
  });

  it("is independent of `mutatingToolsEnabled`", () => {
    // pdv_run callers MUST also call assertMutatingToolsEnabled; this helper
    // does not enforce that on its own (and shouldn't — separation of
    // concerns lets each gate be tested in isolation).
    expect(() =>
      assertPdvRunEnabled(
        makeCtx({ pdvRunEnabled: true, mutatingToolsEnabled: false }),
      ),
    ).not.toThrow();
  });
});
