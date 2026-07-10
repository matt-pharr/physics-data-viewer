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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  copyEnvFilesForLoad,
  copyEnvFilesForSave,
  overlayAutosaveTreeFiles,
  syncUvEnvironmentForLoad,
} from "./project-file-sync";

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

describe("copyEnvFilesForLoad() / copyEnvFilesForSave()", () => {
  let saveDir: string;
  let workingDir: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-envfiles-"));
    saveDir = path.join(root, "save");
    workingDir = path.join(root, "working");
    await fs.mkdir(saveDir, { recursive: true });
    await fs.mkdir(workingDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(saveDir), { recursive: true, force: true });
  });

  it("copies pyproject.toml and uv.lock from the save dir into the working dir", async () => {
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "[project]\n");
    await fs.writeFile(path.join(saveDir, "uv.lock"), "version = 1\n");

    const copied = await copyEnvFilesForLoad(saveDir, workingDir);

    expect(copied.sort()).toEqual(["pyproject.toml", "uv.lock"]);
    expect(await fs.readFile(path.join(workingDir, "pyproject.toml"), "utf8")).toBe("[project]\n");
    expect(await fs.readFile(path.join(workingDir, "uv.lock"), "utf8")).toBe("version = 1\n");
  });

  it("skips env files absent from the save dir", async () => {
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "[project]\n");

    const copied = await copyEnvFilesForLoad(saveDir, workingDir);

    expect(copied).toEqual(["pyproject.toml"]);
    await expect(fs.stat(path.join(workingDir, "uv.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("copies env files back from the working dir into the save dir on save", async () => {
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "[project]\nname='x'\n");
    await fs.writeFile(path.join(workingDir, "uv.lock"), "version = 1\n");

    const copied = await copyEnvFilesForSave(workingDir, saveDir);

    expect(copied.sort()).toEqual(["pyproject.toml", "uv.lock"]);
    expect(await fs.readFile(path.join(saveDir, "pyproject.toml"), "utf8")).toBe(
      "[project]\nname='x'\n",
    );
  });

  it("does not clobber a saved uv.lock when the working dir lacks one", async () => {
    await fs.writeFile(path.join(saveDir, "uv.lock"), "good-lock\n");
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "[project]\n");

    const copied = await copyEnvFilesForSave(workingDir, saveDir);

    expect(copied).toEqual(["pyproject.toml"]);
    expect(await fs.readFile(path.join(saveDir, "uv.lock"), "utf8")).toBe("good-lock\n");
  });

  it("round-trips the .python-version pin through save and open (§10.5.8)", async () => {
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "[project]\n");
    await fs.writeFile(path.join(workingDir, ".python-version"), "3.12\n");

    const savedNames = await copyEnvFilesForSave(workingDir, saveDir);
    expect(savedNames).toContain(".python-version");

    const otherWorkingDir = path.join(path.dirname(saveDir), "working2");
    await fs.mkdir(otherWorkingDir, { recursive: true });
    const loadedNames = await copyEnvFilesForLoad(saveDir, otherWorkingDir);
    expect(loadedNames).toContain(".python-version");
    expect(await fs.readFile(path.join(otherWorkingDir, ".python-version"), "utf8")).toBe(
      "3.12\n",
    );
  });
});

describe("syncUvEnvironmentForLoad()", () => {
  let saveDir: string;
  let workingDir: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-envsync-"));
    saveDir = path.join(root, "save");
    workingDir = path.join(root, "working");
    await fs.mkdir(saveDir, { recursive: true });
    await fs.mkdir(workingDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(saveDir), { recursive: true, force: true });
  });

  const okSync = vi.fn(async () => ({ success: true, output: "" }));

  it("no-ops (and leaves the working dir untouched) when the save has no pyproject.toml", async () => {
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "previous-project\n");
    okSync.mockClear();

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, { runUvSync: okSync });

    expect(result).toEqual({ copied: [], synced: false });
    expect(okSync).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(workingDir, "pyproject.toml"), "utf8")).toBe(
      "previous-project\n",
    );
  });

  it("short-circuits without copying or syncing when env files already match", async () => {
    // The standard open flow: a fresh kernel was just materialized from this
    // save dir, so the working dir's env files are byte-identical copies.
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "same-project\n");
    await fs.writeFile(path.join(saveDir, "uv.lock"), "same-lock\n");
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "same-project\n");
    await fs.writeFile(path.join(workingDir, "uv.lock"), "same-lock\n");
    okSync.mockClear();

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
      runningPythonVersion: "3.13",
      runUvSync: okSync,
    });

    expect(result).toEqual({ copied: [], synced: true });
    expect(okSync).not.toHaveBeenCalled();
  });

  it("does not short-circuit when a file exists on only one side", async () => {
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "same-project\n");
    await fs.writeFile(path.join(saveDir, "uv.lock"), "opened-lock\n");
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "same-project\n");
    okSync.mockClear();

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
      runningPythonVersion: "3.13",
      runUvSync: okSync,
    });

    expect(result.synced).toBe(true);
    expect(result.copied).toContain("uv.lock");
    expect(okSync).toHaveBeenCalledOnce();
  });

  it("replaces the previous project's env files and syncs the venv", async () => {
    // Working dir holds the abandoned project's env spec — the exact state
    // that used to leak into the opened project on save.
    await fs.writeFile(path.join(workingDir, "pyproject.toml"), "previous-project\n");
    await fs.writeFile(path.join(workingDir, "uv.lock"), "previous-lock\n");
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "opened-project\n");
    await fs.writeFile(path.join(saveDir, "uv.lock"), "opened-lock\n");
    okSync.mockClear();

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
      runningPythonVersion: "3.13",
      runUvSync: okSync,
    });

    expect(result.synced).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.copied).toEqual(expect.arrayContaining(["pyproject.toml", "uv.lock"]));
    expect(okSync).toHaveBeenCalledWith(workingDir);
    expect(await fs.readFile(path.join(workingDir, "pyproject.toml"), "utf8")).toBe(
      "opened-project\n",
    );
    expect(await fs.readFile(path.join(workingDir, "uv.lock"), "utf8")).toBe("opened-lock\n");
  });

  it("skips the sync with a warning when the project pins a different Python", async () => {
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "opened-project\n");
    await fs.writeFile(path.join(saveDir, ".python-version"), "3.12\n");
    okSync.mockClear();

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
      runningPythonVersion: "3.13",
      runUvSync: okSync,
    });

    expect(result.synced).toBe(false);
    expect(result.warning).toMatch(/pins Python 3\.12.*running.*3\.13/s);
    expect(okSync).not.toHaveBeenCalled();
    // Env files are still copied so a later save round-trips correctly.
    expect(await fs.readFile(path.join(workingDir, "pyproject.toml"), "utf8")).toBe(
      "opened-project\n",
    );
  });

  it("syncs when the pin matches the running version (patch-level pin included)", async () => {
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "opened-project\n");
    await fs.writeFile(path.join(saveDir, ".python-version"), "3.13.2\n");
    okSync.mockClear();

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
      runningPythonVersion: "3.13",
      runUvSync: okSync,
    });

    expect(result.synced).toBe(true);
    expect(okSync).toHaveBeenCalledOnce();
  });

  it("returns a warning when uv sync fails, without throwing", async () => {
    await fs.writeFile(path.join(saveDir, "pyproject.toml"), "opened-project\n");
    const failSync = vi.fn(async () => ({ success: false, output: "resolution failed" }));

    const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
      runningPythonVersion: "3.13",
      runUvSync: failSync,
    });

    expect(result.synced).toBe(false);
    expect(result.warning).toMatch(/uv sync failed/);
  });
});
