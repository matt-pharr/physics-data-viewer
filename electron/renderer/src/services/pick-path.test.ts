// @vitest-environment jsdom

/**
 * pick-path.test.ts — the local/remote routing decision.
 *
 * Local sessions must keep the native dialogs byte-for-byte (that is the
 * "local mode unaffected" invariant); anything else goes to the mounted
 * picker. The router is one `if` — but it is the `if` that decides which
 * MACHINE a path browse happens on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pickServerPath,
  registerPathPickerHost,
  type ActivePickRequest,
} from "./pick-path";
import { useStore } from "../store";

const files = {
  pickExecutable: vi.fn(async () => "/native/exec"),
  pickFile: vi.fn(async () => "/native/file"),
  pickDirectory: vi.fn(async () => "/native/dir"),
  listDir: vi.fn(),
};

let unregister: (() => void) | null = null;

beforeEach(() => {
  (window as unknown as { pdv: unknown }).pdv = { files };
  files.pickExecutable.mockClear();
  files.pickFile.mockClear();
  files.pickDirectory.mockClear();
  useStore.setState({ connectionState: "local" });
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("pickServerPath", () => {
  it("routes every mode to its native dialog while local", async () => {
    await expect(
      pickServerPath({ mode: "directory", title: "t", defaultPath: "/seed" }),
    ).resolves.toBe("/native/dir");
    expect(files.pickDirectory).toHaveBeenCalledWith("/seed");

    await expect(pickServerPath({ mode: "executable", title: "t" })).resolves.toBe(
      "/native/exec",
    );
    await expect(pickServerPath({ mode: "file", title: "t" })).resolves.toBe(
      "/native/file",
    );
  });

  it("routes to the mounted picker when the session is remote", async () => {
    useStore.setState({ connectionState: "remote-connected" });
    let received: ActivePickRequest | null = null;
    unregister = registerPathPickerHost((req) => {
      received = req;
    });

    const result = pickServerPath({ mode: "directory", title: "Pick" });
    expect(received).not.toBeNull();
    expect(files.pickDirectory).not.toHaveBeenCalled();

    received!.resolve("/remote/answer");
    await expect(result).resolves.toBe("/remote/answer");
  });

  it("uses the in-app picker even while the remote session is unreachable", async () => {
    // remote-lost still means the session (and its filesystem) is the
    // remote one — a native dialog would browse the wrong machine.
    useStore.setState({ connectionState: "remote-lost" });
    let received: ActivePickRequest | null = null;
    unregister = registerPathPickerHost((req) => {
      received = req;
    });

    void pickServerPath({ mode: "file", title: "Pick" });
    expect(received).not.toBeNull();
    expect(files.pickFile).not.toHaveBeenCalled();
  });

  it("resolves null instead of hanging when no picker is mounted", async () => {
    useStore.setState({ connectionState: "remote-connected" });
    await expect(pickServerPath({ mode: "file", title: "t" })).resolves.toBeNull();
  });
});
