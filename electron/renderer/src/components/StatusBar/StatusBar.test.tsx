// @vitest-environment jsdom

/**
 * StatusBar.test.tsx — Renderer tests for the bottom status bar.
 *
 * Covers the MCP connection-indicator dot wired in for Phase 3 of the MCP
 * server work, and the restart-affordance visibility matrix (§11.6): the
 * ⟳ Restart item must render while connected AND after a crash when a
 * restartable session exists (`canRestart`), but never for a failed start.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusBar } from "./index";

afterEach(() => {
  cleanup();
});

function renderStatusBar(
  overrides: {
    mcpClientAttached?: boolean;
    kernelStatus?: "idle" | "starting" | "ready" | "error";
    canRestart?: boolean;
    onRestartSession?: () => void;
  } = {},
): void {
  render(
    <StatusBar
      isExecuting={false}
      activeLanguage="python"
      pythonPath="/usr/bin/python3"
      juliaPath={undefined}
      kernelSpec={undefined}
      currentProjectDir={null}
      kernelStatus={overrides.kernelStatus ?? "idle"}
      lastDuration={null}
      progress={null}
      onRuntimeClick={vi.fn()}
      onRestartSession={overrides.onRestartSession}
      canRestart={overrides.canRestart}
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

describe("StatusBar restart affordance (§11.6)", () => {
  const onRestartSession = vi.fn();

  it("renders while connected", () => {
    renderStatusBar({ kernelStatus: "ready", onRestartSession });
    expect(screen.getByTestId("restart-session")).toBeTruthy();
  });

  it("renders after a crash when a restartable session exists", () => {
    renderStatusBar({ kernelStatus: "error", canRestart: true, onRestartSession });
    const item = screen.getByTestId("restart-session");
    expect(item).toBeTruthy();
    // Crash-specific tooltip tells the user what a restart will recover.
    expect(item.getAttribute("title")).toMatch(/crashed/i);
  });

  it("hidden in the error state when there is nothing to restart (failed start)", () => {
    renderStatusBar({ kernelStatus: "error", canRestart: false, onRestartSession });
    expect(screen.queryByTestId("restart-session")).toBeNull();
  });

  it("hidden while starting and when no handler is wired", () => {
    renderStatusBar({ kernelStatus: "starting", canRestart: true, onRestartSession });
    expect(screen.queryByTestId("restart-session")).toBeNull();
    renderStatusBar({ kernelStatus: "ready" });
    expect(screen.queryByTestId("restart-session")).toBeNull();
  });
});
