// @vitest-environment jsdom

/**
 * RemoteConnect.test.tsx — the connect dialog.
 *
 * Two behaviours here are correctness, not presentation: the reply field
 * must mask itself when the shell says the prompt is secret, and the dialog
 * must not tell the user their session moved to the host when it has not.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteConnect } from "./index";
import { useStore } from "../../store";
import type { RemoteStatus } from "../../types";

const remote = {
  listHosts: vi.fn(async () => [
    { alias: "flux", hostName: "flux.pppl.gov", user: "mpharr" },
    { alias: "feyn", hostName: "feynman.ap.columbia.edu", user: "mcp2198" },
  ]),
  connect: vi.fn(async () => ({ ok: true, failure: null, message: "" })),
  respond: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  getStatus: vi.fn(async () => ({ phase: "idle", host: null, attemptId: null })),
  onStatus: vi.fn(() => () => {}),
};

/** Drive the store the way a pushed status would, and let React react. */
function push(partial: Partial<RemoteStatus>): void {
  act(() => {
    useStore.getState().applyRemoteStatus({
      phase: "idle",
      host: null,
      attemptId: null,
      ...partial,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { pdv: unknown }).pdv = { remote };
  useStore.setState({
    remotePhase: "idle",
    remoteConnectHost: null,
    remoteNode: null,
    remoteLog: "",
    remoteSecret: false,
    remoteMessage: null,
    remoteAttemptId: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("RemoteConnect", () => {
  it("connects to a typed destination", async () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("host or user@host"), {
      target: { value: "mpharr@flux.pppl.gov" },
    });
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(remote.connect).toHaveBeenCalledWith("mpharr@flux.pppl.gov"));
  });

  it("offers the aliases from the ssh config", async () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    await waitFor(() => expect(remote.listHosts).toHaveBeenCalled());
    // Queried directly: jsdom does not expose <option> inside a <datalist>
    // with the "option" role, so getByRole would never find these.
    await waitFor(() => {
      const values = Array.from(
        document.querySelectorAll("#remote-host-aliases option"),
      ).map((el) => el.getAttribute("value"));
      expect(values).toEqual(["flux", "feyn"]);
    });
  });

  it("shows streamed ssh output verbatim", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "prompting", host: "flux", attemptId: "a1", output: "Duo two-factor login" });
    expect(screen.getByText(/Duo two-factor login/)).toBeTruthy();
  });

  it("masks the reply field when the prompt is secret", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "prompting", host: "flux", attemptId: "a1", secret: true });
    const field = screen.getByPlaceholderText("Hidden while you type");
    // A password rendered as plain text reaches screen recordings and
    // screenshots attached to bug reports.
    expect(field.getAttribute("type")).toBe("password");
  });

  it("leaves a non-secret prompt visible", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "prompting", host: "flux", attemptId: "a1", secret: false });
    expect(screen.getByPlaceholderText("Your answer").getAttribute("type")).toBe("text");
  });

  it("sends the reply and clears the field immediately", async () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "prompting", host: "flux", attemptId: "a1", secret: true });
    const field = screen.getByPlaceholderText("Hidden while you type") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(remote.respond).toHaveBeenCalledWith("123456"));
    // Not left sitting in the DOM once sent.
    expect(field.value).toBe("");
  });

  it("does not claim the session moved to the host", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "connected", host: "flux", attemptId: "a1", node: "flux-login1" });
    expect(screen.getByText(/Connected to/)).toBeTruthy();
    // The session is still local; saying otherwise would be a lie until the
    // server actually runs on the host.
    expect(screen.getByText(/still runs on your computer/)).toBeTruthy();
  });

  it("shows which login node answered a load-balanced alias", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "connected", host: "flux", attemptId: "a1", node: "flux-login1" });
    expect(screen.getByText(/flux-login1/)).toBeTruthy();
  });

  it("offers Cancel only while an attempt is in flight", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    expect(screen.queryByText("Cancel")).toBeNull();
    push({ phase: "connecting", host: "flux", attemptId: "a1" });
    fireEvent.click(screen.getByText("Cancel"));
    expect(remote.cancel).toHaveBeenCalled();
  });

  it("offers Disconnect only once connected", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    expect(screen.queryByText("Disconnect")).toBeNull();
    push({ phase: "connected", host: "feyn", attemptId: "a1" });
    fireEvent.click(screen.getByText("Disconnect"));
    expect(remote.disconnect).toHaveBeenCalled();
  });

  it("surfaces a failure message", () => {
    render(<RemoteConnect onClose={vi.fn()} />);
    push({ phase: "failed", host: "flux", attemptId: "a1", message: "Permission denied" });
    expect(screen.getByText("Permission denied")).toBeTruthy();
  });

  it("closes on request", () => {
    const onClose = vi.fn();
    render(<RemoteConnect onClose={onClose} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shutting the session down takes two clicks, with the warning between", async () => {
    // One click must never end a session — it kills the remote kernel and
    // whatever unsaved work lives in it.
    const endSession = vi.fn(async () => ({ ok: true }));
    (window as unknown as { pdv: { remote: object } }).pdv = {
      remote: { ...remote, endSession, startSession: vi.fn() },
    };
    push({ phase: "connected", host: "flux" });
    act(() => {
      useStore.setState({ connectionState: "remote-connected" });
    });
    render(<RemoteConnect onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Shut Down Remote Session"));
    expect(endSession).not.toHaveBeenCalled();
    expect(screen.getByText(/anything unsaved there is lost/)).toBeTruthy();

    fireEvent.click(screen.getByText("Yes, Shut It Down"));
    await waitFor(() => {
      expect(endSession).toHaveBeenCalledOnce();
    });
  });

  it("a failed shutdown says why instead of pretending nothing happened", async () => {
    // The UI cousin of "reports success while the daemon keeps running":
    // the decline message ("unreachable right now…") must reach the user.
    const endSession = vi.fn(async () => ({ ok: false, message: "still unreachable" }));
    (window as unknown as { pdv: { remote: object } }).pdv = {
      remote: { ...remote, endSession },
    };
    push({ phase: "connected", host: "flux" });
    act(() => {
      useStore.setState({ connectionState: "remote-connected" });
    });
    render(<RemoteConnect onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Shut Down Remote Session"));
    fireEvent.click(screen.getByText("Yes, Shut It Down"));

    await screen.findByText("still unreachable");
  });

  it("Reconnect actually starts the session, and Disconnect disarms the shutdown", async () => {
    const startSession = vi.fn(async () => ({ ok: true, sessionId: "s" }));
    const disconnect = vi.fn(async () => undefined);
    (window as unknown as { pdv: { remote: object } }).pdv = {
      remote: { ...remote, startSession, disconnect },
    };
    push({ phase: "connected", host: "flux" });
    act(() => {
      useStore.setState({ connectionState: "remote-lost" });
    });
    const { unmount } = render(<RemoteConnect onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Reconnect to flux"));
    await waitFor(() => {
      expect(startSession).toHaveBeenCalledOnce();
    });
    unmount();

    // Disarm-on-Disconnect: an armed confirm must not survive the action
    // that makes it moot.
    act(() => {
      useStore.setState({ connectionState: "remote-connected" });
    });
    render(<RemoteConnect onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Shut Down Remote Session"));
    expect(screen.getByText(/Shut it down\?/)).toBeTruthy();
    fireEvent.click(screen.getByText("Disconnect"));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Shut it down\?/)).toBeNull();
  });

  it("renders a session error raised by flows outside the dialog", () => {
    // An open-recent flow's startSession failure lands in the store — the
    // dialog is the surface the user is looking at, so it must show it.
    push({ phase: "connected", host: "flux" });
    act(() => {
      useStore.setState({ connectionState: "local", remoteSessionError: "no session for you" });
    });
    render(<RemoteConnect onClose={vi.fn()} />);
    expect(screen.getByText("no session for you")).toBeTruthy();
  });

  it("offers Reconnect when the session is lost — and holds back while auto-reconnecting", () => {
    push({ phase: "connected", host: "flux" });
    act(() => {
      useStore.setState({ connectionState: "remote-lost" });
    });
    const { unmount } = render(<RemoteConnect onClose={vi.fn()} />);
    const button = screen.getByText("Reconnect to flux");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/unreachable right now/)).toBeTruthy();
    unmount();

    // While the shell's automatic backoff is running, a manual attempt
    // would race it — the button waits.
    act(() => {
      useStore.setState({ connectionState: "remote-reconnecting" });
    });
    render(<RemoteConnect onClose={vi.fn()} />);
    expect(
      (screen.getByText("Reconnect to flux") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
