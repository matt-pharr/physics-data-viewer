// @vitest-environment jsdom

/**
 * PathPicker.test.tsx — the bare remote path picker.
 *
 * What must hold: every exit resolves the request exactly once (a caller
 * `await`s this promise — an unresolved exit hangs its whole flow), paths
 * join correctly at the root, directory mode filters files out, and a
 * failed listing keeps the last good one on screen.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PathPicker } from "./index";
import type { ActivePickRequest } from "../../services/pick-path";
import type { ListDirResult } from "../../types";

const listDir = vi.fn();

beforeEach(() => {
  (window as unknown as { pdv: unknown }).pdv = { files: { listDir } };
  listDir.mockReset();
});

afterEach(() => {
  cleanup();
});

function listing(dir: string, entries: ListDirResult["entries"]): ListDirResult {
  return { path: dir, entries, home: "/home/user" };
}

function makeRequest(over: Partial<ActivePickRequest> = {}) {
  const resolve = vi.fn<(path: string | null) => void>();
  const onDone = vi.fn<() => void>();
  const request: ActivePickRequest = {
    mode: "directory",
    title: "Pick something",
    resolve,
    seq: 1,
    ...over,
  };
  return { request, resolve, onDone };
}

describe("PathPicker", () => {
  it("selects the listed directory and resolves exactly once", async () => {
    listDir.mockResolvedValue(listing("/data", [{ name: "runs", kind: "dir" }]));
    const { request, resolve, onDone } = makeRequest();
    render(<PathPicker request={request} onDone={onDone} />);

    await screen.findByText("runs/");
    fireEvent.click(screen.getByRole("button", { name: "Select This Folder" }));

    expect(resolve).toHaveBeenCalledExactlyOnceWith("/data");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("clicking a file in file mode resolves its full path — root join included", async () => {
    listDir.mockResolvedValue(listing("/", [{ name: "data.h5", kind: "file" }]));
    const { request, resolve } = makeRequest({ mode: "file" });
    render(<PathPicker request={request} onDone={() => undefined} />);

    fireEvent.click(await screen.findByText("data.h5"));

    // "//data.h5" is the classic root-join bug.
    expect(resolve).toHaveBeenCalledExactlyOnceWith("/data.h5");
  });

  it("directory mode hides files entirely", async () => {
    listDir.mockResolvedValue(
      listing("/data", [
        { name: "runs", kind: "dir" },
        { name: "notes.txt", kind: "file" },
      ]),
    );
    const { request } = makeRequest({ mode: "directory" });
    render(<PathPicker request={request} onDone={() => undefined} />);

    await screen.findByText("runs/");
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("Escape cancels with null", async () => {
    listDir.mockResolvedValue(listing("/data", []));
    const { request, resolve, onDone } = makeRequest();
    render(<PathPicker request={request} onDone={onDone} />);
    const input = await screen.findByDisplayValue("/data");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("Enter resolves exactly what was typed (the escape hatch)", async () => {
    listDir.mockResolvedValue(listing("/data", []));
    const { request, resolve } = makeRequest({ mode: "file" });
    render(<PathPicker request={request} onDone={() => undefined} />);
    const input = await screen.findByDisplayValue("/data");

    fireEvent.change(input, { target: { value: "/scratch/odd path/file.nc" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(resolve).toHaveBeenCalledExactlyOnceWith("/scratch/odd path/file.nc");
  });

  it("a failed listing keeps the last good one and shows the error", async () => {
    listDir.mockResolvedValueOnce(listing("/data", [{ name: "runs", kind: "dir" }]));
    listDir.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    const { request } = makeRequest();
    render(<PathPicker request={request} onDone={() => undefined} />);

    fireEvent.click(await screen.findByText("runs/"));

    await screen.findByText(/EACCES/);
    // The previous listing is still usable.
    expect(screen.getByText("runs/")).toBeTruthy();
  });

  it("'..' climbs to the parent, and maps a top-level dir to the root", async () => {
    listDir.mockResolvedValueOnce(listing("/home", [{ name: "user", kind: "dir" }]));
    listDir.mockResolvedValueOnce(listing("/", [{ name: "home", kind: "dir" }]));
    const { request } = makeRequest();
    render(<PathPicker request={request} onDone={() => undefined} />);

    await screen.findByText("user/");
    fireEvent.click(screen.getByText(".."));

    await waitFor(() => {
      // The parent of '/home' must be '/', not '' (the classic regex bug).
      expect(listDir).toHaveBeenLastCalledWith("/");
    });
    // And at the root, the '..' entry disappears.
    await screen.findByText("home/");
    expect(screen.queryByText("..")).toBeNull();
  });

  it("Cancel resolves null", async () => {
    listDir.mockResolvedValue(listing("/data", []));
    const { request, resolve, onDone } = makeRequest();
    render(<PathPicker request={request} onDone={onDone} />);
    await screen.findByDisplayValue("/data");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("Enter on an emptied field cancels rather than resolving ''", async () => {
    listDir.mockResolvedValue(listing("/data", []));
    const { request, resolve } = makeRequest({ mode: "file" });
    render(<PathPicker request={request} onDone={() => undefined} />);
    const input = await screen.findByDisplayValue("/data");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("Home works even when the first listing failed", async () => {
    listDir.mockRejectedValueOnce(new Error("ENOENT: no such directory"));
    listDir.mockResolvedValueOnce(listing("/home/user", []));
    const { request } = makeRequest({ defaultPath: "/gone" });
    render(<PathPicker request={request} onDone={() => undefined} />);

    await screen.findByText(/ENOENT/);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("/home/user")).toBeTruthy();
    });
    // Home = "list the default", not "list some stored path".
    expect(listDir).toHaveBeenLastCalledWith(undefined);
  });
});
