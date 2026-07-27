// @vitest-environment jsdom

/**
 * RemoteHostsTab.test.tsx — the per-host settings tab.
 *
 * The behaviours worth pinning are the ones that lose data or test the
 * wrong thing: switching hosts must park (not destroy) unsaved edits, Save
 * must send the complete draft for exactly the selected host, and the Test
 * button must send the EDITOR's current text — testing the saved copy would
 * approve a script the user is about to change.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteHostsTab } from "./RemoteHostsTab";
import { useStore } from "../../store";
import type { RemoteHostConfigPayload, RemoteSetupTestResult } from "../../types";

const hostConfigs: Record<string, RemoteHostConfigPayload> = {};

const remote = {
  listHosts: vi.fn(async () => [
    { alias: "flux", hostName: "flux.pppl.gov", user: "mpharr" },
    { alias: "feyn", hostName: "feynman.ap.columbia.edu", user: "mcp2198" },
  ]),
  listConfiguredHosts: vi.fn(async () => Object.keys(hostConfigs)),
  getHostConfig: vi.fn(
    async (host: string): Promise<RemoteHostConfigPayload> =>
      hostConfigs[host] ?? { settings: {}, setupScript: "", sessionNode: null },
  ),
  setHostConfig: vi.fn(async () => undefined),
  testSetupScript: vi.fn(
    async (): Promise<RemoteSetupTestResult> => ({
      ok: true,
      exitCode: 0,
      output: "Loading python module",
      before: [{ name: "python3", path: null, version: null }],
      after: [{ name: "python3", path: "/opt/mod/bin/python3", version: "Python 3.12.1" }],
    }),
  ),
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(hostConfigs)) delete hostConfigs[key];
  (window as unknown as { pdv: unknown }).pdv = { remote };
  useStore.setState({ remotePhase: "idle", remoteConnectHost: null });
});

afterEach(() => {
  cleanup();
});

/** Render and wait until the first host's config has loaded. */
async function renderLoaded(): Promise<void> {
  render(<RemoteHostsTab />);
  await waitFor(() => expect(screen.getByLabelText("Working directory")).toBeTruthy());
}

describe("RemoteHostsTab", () => {
  it("lists ssh-config aliases plus configured-only hosts", async () => {
    hostConfigs["old-cluster"] = {
      settings: { workingDirBase: "/scratch" },
      setupScript: "",
      sessionNode: null,
    };
    await renderLoaded();
    const listed = [...document.querySelectorAll(".settings-remote-host-name")].map(
      (el) => el.textContent,
    );
    // Configured-only hosts (the hand-written script era) must still appear
    // even though the ssh config no longer lists them.
    expect(listed).toEqual(["flux", "feyn", "old-cluster"]);
  });

  it("saves the complete draft for the selected host", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Working directory"), {
      target: { value: "/scratch/local/m" },
    });
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save flux/ }));

    await waitFor(() =>
      expect(remote.setHostConfig).toHaveBeenCalledWith("flux", {
        settings: { workingDirBase: "/scratch/local/m" },
        setupScript: "module load python\n",
      }),
    );
  });

  it("parks unsaved edits when switching hosts instead of destroying them", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Working directory"), {
      target: { value: "/scratch/edited" },
    });

    fireEvent.click(screen.getByText("feyn"));
    await waitFor(() =>
      expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe(""),
    );
    // The parked draft is flagged in the host list...
    expect(screen.getByTitle("Unsaved changes")).toBeTruthy();

    // ...and restored intact on return.
    fireEvent.click(screen.getByText("flux"));
    await waitFor(() =>
      expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe(
        "/scratch/edited",
      ),
    );
  });

  it("disables Test unless connected to the selected host", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\n" },
    });
    const button = screen.getByRole("button", { name: "Test on host" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Connect to flux to test/)).toBeTruthy();
  });

  it("tests the editor's current text and renders the interpreter diff", async () => {
    useStore.setState({ remotePhase: "connected", remoteConnectHost: "flux" });
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test on host" }));

    // The EDITOR's text, unsaved — the point of Test is trying an edit.
    await waitFor(() =>
      expect(remote.testSetupScript).toHaveBeenCalledWith("flux", "module load python\n"),
    );
    expect(remote.setHostConfig).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByText("Script sourced cleanly.")).toBeTruthy());
    // The script's own output — the bytes the daemon's capture discards.
    expect(screen.getByText("Loading python module")).toBeTruthy();
    expect(screen.getByText("/opt/mod/bin/python3 — Python 3.12.1")).toBeTruthy();
    expect(screen.getByText("not found")).toBeTruthy();
  });

  it("shows the recorded session node", async () => {
    hostConfigs["flux"] = {
      settings: {},
      setupScript: "",
      sessionNode: "flux-login1.pppl.gov",
    };
    await renderLoaded();
    expect(screen.getByText("flux-login1.pppl.gov")).toBeTruthy();
    expect(screen.getByText(/reconnects aim there/)).toBeTruthy();
  });

  it("reveals the Slurm fields only in slurm mode, and saves them", async () => {
    await renderLoaded();
    expect(screen.queryByLabelText("Account")).toBeNull();

    fireEvent.change(screen.getByLabelText("Run kernels"), {
      target: { value: "slurm" },
    });
    fireEvent.change(screen.getByLabelText("Account"), {
      target: { value: "myproject" },
    });
    fireEvent.change(screen.getByLabelText("Partition"), {
      target: { value: "general" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save flux/ }));

    await waitFor(() =>
      expect(remote.setHostConfig).toHaveBeenCalledWith("flux", {
        settings: { launch: { mode: "slurm", account: "myproject", partition: "general" } },
        setupScript: "",
      }),
    );
  });

  it("adds a free-typed destination to the list", async () => {
    await renderLoaded();
    const input = screen.getByPlaceholderText("user@host");
    fireEvent.change(input, { target: { value: "mpharr@new-cluster" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(remote.getHostConfig).toHaveBeenCalledWith("mpharr@new-cluster"),
    );
    const listed = [...document.querySelectorAll(".settings-remote-host-name")].map(
      (el) => el.textContent,
    );
    expect(listed).toContain("mpharr@new-cluster");
  });
});
