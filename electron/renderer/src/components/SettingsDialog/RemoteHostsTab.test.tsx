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

import { clearParkedDraftsForTests, RemoteHostsTab } from "./RemoteHostsTab";
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
  forgetHost: vi.fn(async () => undefined),
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
  clearParkedDraftsForTests();
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

  it("saves the Forward X11 toggle, and unchecking clears the key entirely", async () => {
    await renderLoaded();
    const checkbox = screen.getByLabelText("Forward X11");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /Save flux/ }));
    await waitFor(() =>
      expect(remote.setHostConfig).toHaveBeenCalledWith("flux", {
        settings: { forwardX11: true },
        setupScript: "",
      }),
    );

    // Unchecking must drop the key (undefined), not persist `false` — the
    // store treats an absent field as cleared and dirtiness compares the
    // serialized shapes.
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /Save flux/ }));
    await waitFor(() =>
      expect(remote.setHostConfig).toHaveBeenLastCalledWith("flux", {
        settings: {},
        setupScript: "",
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

  it("clears a test verdict the moment the script is edited", async () => {
    // A verdict describes the exact bytes that were tested; a green
    // "sourced cleanly" under text that was never tested invites shipping
    // an untested script.
    useStore.setState({ remotePhase: "connected", remoteConnectHost: "flux" });
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test on host" }));
    await waitFor(() => expect(screen.getByText("Script sourced cleanly.")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\nmodule load julia\n" },
    });
    expect(screen.queryByText("Script sourced cleanly.")).toBeNull();
  });

  it("does not leak a test verdict onto a host added via the input", async () => {
    useStore.setState({ remotePhase: "connected", remoteConnectHost: "flux" });
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test on host" }));
    await waitFor(() => expect(screen.getByText("Script sourced cleanly.")).toBeTruthy());

    const input = screen.getByPlaceholderText("user@host");
    fireEvent.change(input, { target: { value: "otherhost" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByText("Script sourced cleanly.")).toBeNull();
  });

  it("suppresses the probe table when the test could not finish", async () => {
    // "python3: not found" rows under an exit-line diagnosis read as "my
    // script breaks python" — those probes never ran.
    remote.testSetupScript.mockResolvedValueOnce({
      ok: false,
      exitCode: 0,
      output: "about to bail",
      before: [{ name: "python3", path: "/usr/bin/python3", version: "3.12" }],
      after: [{ name: "python3", path: null, version: null }],
      message: "The script ended the shell before the test could finish.",
    });
    useStore.setState({ remotePhase: "connected", remoteConnectHost: "flux" });
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "exit 0\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test on host" }));

    await waitFor(() =>
      expect(screen.getByText(/ended the shell before/)).toBeTruthy(),
    );
    expect(screen.getByText("about to bail")).toBeTruthy();
    expect(screen.queryByText("not found")).toBeNull();
    expect(screen.queryByText("With script")).toBeNull();
  });

  it("keystrokes during a save round trip stay dirty", async () => {
    // The save baselines what was SENT; text typed while the IPC call was
    // in flight must not be marked clean without being persisted.
    let releaseSave: () => void = () => undefined;
    remote.setHostConfig.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseSave = () => resolve(undefined);
        }),
    );
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save flux/ }));
    // Typed mid-flight:
    fireEvent.change(screen.getByPlaceholderText(/module load/), {
      target: { value: "module load python\nmodule load julia\n" },
    });
    releaseSave();

    // Still dirty: the Save button stays enabled for the unsent tail.
    await waitFor(() => {
      const button = screen.getByRole("button", { name: /Save flux/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  it("dirty drafts survive an unmount and remount (tab switch)", async () => {
    const view = render(<RemoteHostsTab />);
    await waitFor(() => expect(screen.getByLabelText("Working directory")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Working directory"), {
      target: { value: "/scratch/parked" },
    });
    view.unmount(); // The user peeks at the Appearance tab...

    render(<RemoteHostsTab />);
    await waitFor(() =>
      expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe(
        "/scratch/parked",
      ),
    );
    // ...and the parked edit is still dirty, not silently baselined.
    expect(
      (screen.getByRole("button", { name: /Save flux/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("forgets a configured host after confirmation", async () => {
    hostConfigs["old-cluster"] = {
      settings: { workingDirBase: "/scratch" },
      setupScript: "",
      sessionNode: null,
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Forget old-cluster" }));
    await waitFor(() => expect(remote.forgetHost).toHaveBeenCalledWith("old-cluster"));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not forget a host when the confirmation is declined", async () => {
    hostConfigs["old-cluster"] = {
      settings: { workingDirBase: "/scratch" },
      setupScript: "",
      sessionNode: null,
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Forget old-cluster" }));
    expect(remote.forgetHost).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
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
