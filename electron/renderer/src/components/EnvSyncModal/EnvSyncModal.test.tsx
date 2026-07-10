// @vitest-environment jsdom

/**
 * EnvSyncModal.test.tsx — Renderer tests for the unified session-launch modal.
 *
 * Covers: the `syncing` phase (env stage vs kernel-boot stage titles, no
 * action buttons), the `failed` phase (error + Retry / Cancel), and the
 * shared-launch extras (interpreter detail line, "Choose environment…").
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvSyncModal } from "./index";

afterEach(() => {
  cleanup();
});

describe("EnvSyncModal", () => {
  it("shows streamed output and no action buttons while syncing", () => {
    render(
      <EnvSyncModal
        phase="syncing"
        output="Resolving dependencies...\n"
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Setting up project environment/)).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("retitles to 'Starting ipykernel…' at the kernel-boot stage", () => {
    render(
      <EnvSyncModal
        phase="syncing"
        stage="kernel-boot"
        output=""
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Starting ipykernel/)).toBeTruthy();
    expect(screen.queryByText(/Setting up project environment/)).toBeNull();
  });

  it("shows the Julia title and the interpreter detail for shared launches", () => {
    render(
      <EnvSyncModal
        phase="syncing"
        stage="kernel-boot"
        language="julia"
        detail="/usr/local/bin/julia"
        output=""
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Starting the Julia kernel/)).toBeTruthy();
    expect(screen.getByText("/usr/local/bin/julia")).toBeTruthy();
  });

  it("surfaces the error and Retry / Cancel on failure", () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(
      <EnvSyncModal
        phase="failed"
        output="uv sync output"
        errorMessage="uv environment setup failed (sync)"
        onRetry={onRetry}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText(/Session failed to start/)).toBeTruthy();
    expect(screen.getByText(/uv environment setup failed \(sync\)/)).toBeTruthy();
    // No env chooser unless the host provides one (uv launches).
    expect(screen.queryByText(/Choose environment/)).toBeNull();

    screen.getByText("Retry").click();
    expect(onRetry).toHaveBeenCalledOnce();
    screen.getByText("Cancel").click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("offers Choose environment… on failure when the host provides it", () => {
    const onChooseEnv = vi.fn();
    render(
      <EnvSyncModal
        phase="failed"
        output=""
        errorMessage="Kernel handshake failed"
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onChooseEnv={onChooseEnv}
      />
    );
    screen.getByText(/Choose environment/).click();
    expect(onChooseEnv).toHaveBeenCalledOnce();
  });
});
