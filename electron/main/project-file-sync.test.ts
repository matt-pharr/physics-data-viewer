/**
 * project-file-sync.test.ts — Tests for autosave overlay copy.
 *
 * Focuses on `overlayAutosaveTreeFiles` because the cache-persistence change
 * in `pdv-python/pdv/handlers/project.py` makes autosave tree-index entries
 * frequently reference UUIDs whose files live in `<saveDir>/tree/`, not
 * `<autosaveDir>/tree/`. The overlay must silently skip those instead of
 * surfacing them as missing files (the prior behaviour of using
 * `copyFilesForLoad` for the overlay).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { overlayAutosaveTreeFiles } from "./project-file-sync";

describe("overlayAutosaveTreeFiles()", () => {
  let workingDir: string;
  let autosaveDir: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-overlay-"));
    workingDir = path.join(root, "working");
    autosaveDir = path.join(root, "autosave");
    await fs.mkdir(workingDir, { recursive: true });
    await fs.mkdir(autosaveDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(workingDir), { recursive: true, force: true });
  });

  it("no-ops when the autosave dir has no tree/ subdirectory", async () => {
    // Simulates the all-cache-hits case: autosave wrote tree-index.json but
    // no fresh data files because every node was unchanged.
    await expect(overlayAutosaveTreeFiles(autosaveDir, workingDir)).resolves.toBeUndefined();
    // workingDir/tree should still not exist.
    await expect(fs.stat(path.join(workingDir, "tree"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies only the UUIDs present under autosaveDir/tree/", async () => {
    // Set up canonical (saveDir-equivalent) baseline already in workingDir.
    const canonicalUuid = "aaaaaaaaaaaa";
    const changedUuid = "bbbbbbbbbbbb";
    await fs.mkdir(path.join(workingDir, "tree", canonicalUuid), { recursive: true });
    await fs.writeFile(
      path.join(workingDir, "tree", canonicalUuid, "data.npy"),
      "canonical-content",
    );

    // Autosave only writes the changed UUID's file.
    await fs.mkdir(path.join(autosaveDir, "tree", changedUuid), { recursive: true });
    await fs.writeFile(
      path.join(autosaveDir, "tree", changedUuid, "data.npy"),
      "changed-content",
    );

    await overlayAutosaveTreeFiles(autosaveDir, workingDir);

    // Canonical untouched.
    expect(
      await fs.readFile(path.join(workingDir, "tree", canonicalUuid, "data.npy"), "utf8"),
    ).toBe("canonical-content");
    // Changed copied across.
    expect(
      await fs.readFile(path.join(workingDir, "tree", changedUuid, "data.npy"), "utf8"),
    ).toBe("changed-content");
  });

  it("overwrites a working-dir file when the autosave has the same UUID", async () => {
    const uuid = "cccccccccccc";
    await fs.mkdir(path.join(workingDir, "tree", uuid), { recursive: true });
    await fs.writeFile(path.join(workingDir, "tree", uuid, "data.npy"), "old");

    await fs.mkdir(path.join(autosaveDir, "tree", uuid), { recursive: true });
    await fs.writeFile(path.join(autosaveDir, "tree", uuid, "data.npy"), "new");

    await overlayAutosaveTreeFiles(autosaveDir, workingDir);

    expect(
      await fs.readFile(path.join(workingDir, "tree", uuid, "data.npy"), "utf8"),
    ).toBe("new");
  });
});
