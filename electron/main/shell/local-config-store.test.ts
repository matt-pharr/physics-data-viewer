/**
 * local-config-store.test.ts — Ownership, persistence and seeding tests for
 * the shell-owned half of the config.
 *
 * The completeness test is the important one: it pins the rule that decides
 * *where* each key lives, mirroring `channel-partition.test.ts`'s role for
 * IPC channels. Getting ownership wrong is silent — a key on the wrong side
 * still reads and writes, it just follows the wrong thing across a host
 * change.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import type { PDVConfig } from "../config";
import {
  LOCAL_CONFIG_KEYS,
  LocalConfigStore,
  isLocalConfigKey,
  partitionConfigUpdates,
} from "./local-config-store";

/** A full PDVConfig with only the fields a test cares about set. */
function serverConfig(partial: Partial<PDVConfig>): PDVConfig {
  return {
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
    autoRefreshNamespace: false,
    ...partial,
  };
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-local-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config ownership", () => {
  it("keeps every key the server reads for itself on the server side", () => {
    // Each of these is consumed by pdv-server code, not just relayed to the
    // renderer, so it must belong to whichever host runs the session:
    //   pythonPath/juliaPath  — environment detection and kernel spawn
    //   workingDirBase        — session working dirs, autosave scan
    //   defaultPackages/…     — new-project seeding
    //   autoSaveIntervalSeconds — the server's autosave timer
    //   uv                    — uv binary resolution
    //   mcp                   — bearer token minting + tool gating
    const serverOwned = [
      "pythonPath",
      "juliaPath",
      "lastProjectDir",
      "projectRoot",
      "defaultSaveLocation",
      "workingDirBase",
      "autoSaveIntervalSeconds",
      "defaultPackages",
      "defaultJuliaPackages",
      "uv",
      "mcp",
      "showPrivateVariables",
      "showModuleVariables",
      "showCallableVariables",
      "autoRefreshNamespace",
    ];
    for (const key of serverOwned) {
      expect(isLocalConfigKey(key), `${key} must stay server-owned`).toBe(false);
    }
  });

  it("owns exactly the keys nothing on the server reads", () => {
    expect([...LOCAL_CONFIG_KEYS].sort()).toEqual([
      "lastUpdateCheck",
      "launchers",
      "recentProjects",
      "settings",
      "theme",
    ]);
  });

  it("splits a mixed patch into its two halves", () => {
    const { local, server } = partitionConfigUpdates({
      theme: "dark",
      pythonPath: "/usr/bin/python3",
      launchers: { editor: { fileCommand: "code {}" } },
      workingDirBase: "/scratch/me",
    });

    expect(local).toEqual({
      theme: "dark",
      launchers: { editor: { fileCommand: "code {}" } },
    });
    expect(server).toEqual({
      pythonPath: "/usr/bin/python3",
      workingDirBase: "/scratch/me",
    });
  });
});

describe("LocalConfigStore", () => {
  it("round-trips through disk", () => {
    const dir = tempDir();
    new LocalConfigStore(dir).apply({ theme: "dark", lastUpdateCheck: 42 });

    expect(new LocalConfigStore(dir).getAll()).toEqual({
      theme: "dark",
      lastUpdateCheck: 42,
    });
  });

  it("shallow-merges settings and launchers instead of replacing them", () => {
    const store = new LocalConfigStore(tempDir());
    store.apply({
      launchers: { editor: { fileCommand: "code {}" }, agent: { command: "claude" } },
    });

    store.apply({ launchers: { terminal: { preset: "iterm2" } } });

    // A partial launchers update must not drop the sibling slots.
    expect(store.getAll().launchers).toEqual({
      editor: { fileCommand: "code {}" },
      agent: { command: "claude" },
      terminal: { preset: "iterm2" },
    });
  });

  it("ignores undefined values, matching the server-side setter", () => {
    const store = new LocalConfigStore(tempDir());
    store.apply({ theme: "light" });

    store.apply({ theme: undefined });

    expect(store.getAll().theme).toBe("light");
  });

  it("seeds once from a pre-split server config", () => {
    const dir = tempDir();
    const store = new LocalConfigStore(dir);
    expect(store.isSeeded).toBe(false);

    const seeded = store.seedFrom(
      serverConfig({
        theme: "dark",
        settings: { shortcuts: { save: "Cmd+S" } },
        // Server-owned keys must not be dragged across.
        pythonPath: "/usr/bin/python3",
      }),
    );

    expect(seeded).toBe(true);
    expect(store.getAll()).toEqual({
      theme: "dark",
      settings: { shortcuts: { save: "Cmd+S" } },
    });
    expect(new LocalConfigStore(dir).isSeeded).toBe(true);
  });

  it("never re-seeds over a value the user has since changed", () => {
    const dir = tempDir();
    new LocalConfigStore(dir).apply({ theme: "light" });

    const reopened = new LocalConfigStore(dir);
    const seeded = reopened.seedFrom(serverConfig({ theme: "dark" }));

    expect(seeded).toBe(false);
    expect(reopened.getAll().theme).toBe("light");
  });

  it("moves a corrupt file aside and carries on with defaults", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "ui-preferences.json"), "{ not json");

    const store = new LocalConfigStore(dir);

    expect(store.getAll()).toEqual({});
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.includes(".corrupted-"));
    expect(backups).toHaveLength(1);
  });

  it("drops malformed values rather than losing every preference", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "ui-preferences.json"),
      JSON.stringify({ theme: "chartreuse", lastUpdateCheck: 7 }),
    );

    // One bad key must not take the whole file down with it.
    const store = new LocalConfigStore(dir);

    expect(store.getAll()).toEqual({ lastUpdateCheck: 7 });
  });
});
