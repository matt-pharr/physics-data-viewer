// @vitest-environment jsdom

/**
 * StatusBar.test.tsx — Renderer tests for the bottom status bar.
 *
 * Covers the MCP connection-indicator dot wired in for Phase 3 of the MCP
 * server work: the indicator should render only when `mcpClientAttached` is
 * true, and use the `mcp-attached` status-dot modifier so the
 * `--mcp-dot-attached` theme token drives the color.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusBar } from "./index";

afterEach(() => {
  cleanup();
});

function renderStatusBar(overrides: { mcpClientAttached?: boolean } = {}): void {
  render(
    <StatusBar
      isExecuting={false}
      activeLanguage="python"
      pythonPath="/usr/bin/python3"
      juliaPath={undefined}
      kernelSpec={undefined}
      currentProjectDir={null}
      kernelStatus="idle"
      lastDuration={null}
      progress={null}
      onRuntimeClick={vi.fn()}
      lastChecksum={null}
      checksumMismatch={false}
      savedPdvVersion={null}
      runningPdvVersion={null}
      lastAutosaveAt={null}
      kernelMemoryRss={null}
      updateStatus={null}
      onUpdateClick={vi.fn()}
      mcpClientAttached={overrides.mcpClientAttached ?? false}
    />,
  );
}

describe("StatusBar MCP connection indicator", () => {
  it("renders the indicator when an MCP agent is attached", () => {
    renderStatusBar({ mcpClientAttached: true });
    const indicator = screen.getByTestId("mcp-client-indicator");
    expect(indicator).toBeTruthy();
    // The dot uses the `mcp-attached` modifier so the
    // `--mcp-dot-attached` theme token drives the color.
    expect(indicator.querySelector(".status-dot.mcp-attached")).not.toBeNull();
  });

  it("hides the indicator when no MCP agent is attached", () => {
    renderStatusBar({ mcpClientAttached: false });
    expect(screen.queryByTestId("mcp-client-indicator")).toBeNull();
  });
});
