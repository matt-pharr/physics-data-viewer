/**
 * tools/_helpers.test.ts — Unit tests for the mutating-tier gate helpers
 * (`assertMutatingToolsEnabled` / `assertPdvRunEnabled`) and the related
 * `requireKernel` shape implicit in `kernelMutate`.
 */

import { describe, expect, it } from "vitest";

import type { McpToolContext } from "../mcp-context";
import type { ToolExtra } from "./_helpers";
import {
  assertCellReadFresh,
  assertMutatingToolsEnabled,
  assertPdvRunEnabled,
  hashCellCode,
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

describe("assertCellReadFresh (read-before-write guard)", () => {
  /** Build a ctx whose `getCellReadHash` returns a fixed recorded hash. */
  function ctxWithRecordedHash(recorded: string | undefined): McpToolContext {
    return {
      getCellReadHash: () => recorded,
    } as unknown as McpToolContext;
  }
  const extra = { sessionId: "s1" } as ToolExtra;

  it("throws when the session never read this tab", () => {
    expect(() =>
      assertCellReadFresh(ctxWithRecordedHash(undefined), extra, 7, "x = 1"),
    ).toThrow(/must call cell_read/);
  });

  it("throws when the cell changed since the session's last read", () => {
    const staleHash = hashCellCode("x = 1");
    expect(() =>
      assertCellReadFresh(ctxWithRecordedHash(staleHash), extra, 7, "x = 2"),
    ).toThrow(/changed since you last/);
  });

  it("passes when the recorded hash matches the current source", () => {
    const liveHash = hashCellCode("x = 1");
    expect(() =>
      assertCellReadFresh(ctxWithRecordedHash(liveHash), extra, 7, "x = 1"),
    ).not.toThrow();
  });
});
