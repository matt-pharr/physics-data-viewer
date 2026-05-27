// @vitest-environment jsdom

/**
 * EnvSyncModal.test.tsx — Renderer tests for the uv environment-setup modal.
 *
 * Covers the two phases: a `syncing` phase shows progress and no actions; a
 * `failed` phase surfaces the error and the Retry / Cancel buttons.
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
    expect(screen.getByText(/Environment setup failed/)).toBeTruthy();
    expect(screen.getByText(/uv environment setup failed \(sync\)/)).toBeTruthy();

    screen.getByText("Retry").click();
    expect(onRetry).toHaveBeenCalledOnce();
    screen.getByText("Cancel").click();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
