/**
 * host-config.test.ts — persistence and field-ownership tests for the
 * per-host remote settings store.
 *
 * The settings/recorded-state boundary is the load-bearing part: the tab's
 * full-replace save must never wipe the recorded session node, and the pin
 * recorder must never disturb the user's settings. A bug in either
 * direction is silent until a reconnect lands on the wrong login node.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { RemoteHostStore } from "./host-config";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-host-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RemoteHostStore persistence", () => {
  it("round-trips settings through a fresh store instance", () => {
    const dir = tempDir();
    const store = new RemoteHostStore(dir);
    store.setSettings("flux", {
      workingDirBase: "/scratch/local/mpharr",
      defaultSaveLocation: "/p/myproj/mpharr",
      launch: { mode: "slurm", account: "myproj", partition: "general" },
    });

    const reloaded = new RemoteHostStore(dir);
    expect(reloaded.get("flux")).toEqual({
      workingDirBase: "/scratch/local/mpharr",
      defaultSaveLocation: "/p/myproj/mpharr",
      launch: { mode: "slurm", account: "myproj", partition: "general" },
    });
    expect(reloaded.listConfiguredHosts()).toEqual(["flux"]);
  });

  it("returns an empty record for an unknown host", () => {
    const store = new RemoteHostStore(tempDir());
    expect(store.get("nowhere")).toEqual({});
  });

  it("round-trips the forwardX11 toggle and drops a non-boolean value", () => {
    const dir = tempDir();
    const store = new RemoteHostStore(dir);
    store.setSettings("feyn", { forwardX11: true });
    expect(new RemoteHostStore(dir).get("feyn")).toEqual({ forwardX11: true });

    // parseRecord is a hardcoded whitelist: a field missing its branch is
    // silently dropped on save AND load. A truthy string must not survive
    // as a boolean — and only THAT key may be dropped, not the record
    // (the seeded dir setting must survive the bad value).
    store.setSettings("feyn", {
      workingDirBase: "/scratch/mp",
      forwardX11: "yes" as unknown as boolean,
    });
    expect(new RemoteHostStore(dir).get("feyn")).toEqual({
      workingDirBase: "/scratch/mp",
    });
  });

  it("a full-replace save without forwardX11 clears a previously-set toggle", () => {
    const dir = tempDir();
    const store = new RemoteHostStore(dir);
    store.setSettings("feyn", { workingDirBase: "/scratch/mp", forwardX11: true });
    store.setSettings("feyn", { workingDirBase: "/scratch/mp" });
    expect(new RemoteHostStore(dir).get("feyn")).toEqual({
      workingDirBase: "/scratch/mp",
    });
  });

  it("get() returns a snapshot the caller cannot mutate in place", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSettings("feyn", { workingDirBase: "/tmp/w" });
    const snapshot = store.get("feyn");
    snapshot.workingDirBase = "/elsewhere";
    expect(store.get("feyn").workingDirBase).toBe("/tmp/w");
  });

  it("moves a corrupt file aside and starts empty", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "remote-hosts.json"), "{not json");
    const store = new RemoteHostStore(dir);
    expect(store.listConfiguredHosts()).toEqual([]);
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("remote-hosts.json.corrupted-"));
    expect(backups).toHaveLength(1);
  });

  it("drops malformed fields on load without losing the rest of the file", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "remote-hosts.json"),
      JSON.stringify({
        flux: {
          workingDirBase: 42, // wrong type — dropped
          defaultSaveLocation: "/p/myproj",
          launch: { mode: "warp-drive" }, // unknown mode — dropped
        },
        feyn: { sessionNode: "feynman" },
      }),
    );
    const store = new RemoteHostStore(dir);
    expect(store.get("flux")).toEqual({ defaultSaveLocation: "/p/myproj" });
    expect(store.get("feyn")).toEqual({ sessionNode: "feynman" });
  });
});

describe("settings vs recorded state", () => {
  it("setSettings preserves the recorded session node", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSessionNode("flux", "flux-login1.pppl.gov");
    store.setSettings("flux", { workingDirBase: "/scratch/shared/m" });
    expect(store.get("flux")).toEqual({
      sessionNode: "flux-login1.pppl.gov",
      workingDirBase: "/scratch/shared/m",
    });
  });

  it("setSessionNode preserves the user's settings", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSettings("flux", { launch: { mode: "login-node" } });
    store.setSessionNode("flux", "flux-login2.pppl.gov");
    expect(store.get("flux")).toEqual({
      launch: { mode: "login-node" },
      sessionNode: "flux-login2.pppl.gov",
    });
  });

  it("clearing settings does not clear the pin, and vice versa", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSessionNode("flux", "flux-login1");
    store.setSettings("flux", { workingDirBase: "/scratch" });

    store.setSettings("flux", {}); // user cleared every field
    expect(store.get("flux")).toEqual({ sessionNode: "flux-login1" });

    store.setSettings("flux", { workingDirBase: "/scratch" });
    store.setSessionNode("flux", null); // session shut down
    expect(store.get("flux")).toEqual({ workingDirBase: "/scratch" });
  });

  it("removes a host entirely once nothing remains recorded", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSettings("feyn", { workingDirBase: "/tmp/x" });
    store.setSessionNode("feyn", "feynman");
    store.setSettings("feyn", {});
    store.setSessionNode("feyn", null);
    expect(store.listConfiguredHosts()).toEqual([]);
  });

  it("a full-replace save clears fields omitted from the payload", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSettings("flux", {
      workingDirBase: "/scratch",
      launch: { mode: "slurm", account: "a" },
    });
    store.setSettings("flux", { workingDirBase: "/scratch" });
    expect(store.get("flux")).toEqual({ workingDirBase: "/scratch" });
  });

  it("blank strings are treated as cleared, matching the tab's empty fields", () => {
    const store = new RemoteHostStore(tempDir());
    store.setSettings("feyn", {
      workingDirBase: "  ",
      defaultSaveLocation: "",
    });
    expect(store.listConfiguredHosts()).toEqual([]);
  });
});
