/**
 * ipc-register-file-browse.test.ts — the `files:listDir` handler against a
 * real filesystem.
 *
 * Real directories, real symlinks, dispatched through the invoke registry —
 * the handler's whole job is translating what the OS says into the picker's
 * contract, so a mocked fs would test nothing.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IPC, type ListDirResult } from "./ipc";
import { registerFileBrowseIpcHandlers } from "./ipc-register-file-browse";
import { dispatchInvoke, removeAllInvokeHandlers } from "./server/invoke-registry";

let dir: string;

/** Dispatch files:listDir the way the RPC server would. */
async function listDir(dirPath?: string): Promise<ListDirResult> {
  return (await dispatchInvoke(
    IPC.files.listDir,
    { push: () => undefined } as never,
    [dirPath],
  )) as ListDirResult;
}

beforeEach(() => {
  removeAllInvokeHandlers();
  registerFileBrowseIpcHandlers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-listdir-"));
});

afterEach(() => {
  removeAllInvokeHandlers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("files:listDir", () => {
  it("lists directories first, each group sorted by name", async () => {
    fs.writeFileSync(path.join(dir, "beta.txt"), "");
    fs.writeFileSync(path.join(dir, "alpha.txt"), "");
    fs.mkdirSync(path.join(dir, "zeta"));
    fs.mkdirSync(path.join(dir, "eta"));

    const result = await listDir(dir);

    expect(result.path).toBe(dir);
    expect(result.entries).toEqual([
      { name: "eta", kind: "dir" },
      { name: "zeta", kind: "dir" },
      { name: "alpha.txt", kind: "file" },
      { name: "beta.txt", kind: "file" },
    ]);
  });

  it("defaults to the home directory and reports it", async () => {
    const result = await listDir(undefined);
    expect(result.path).toBe(os.homedir());
    expect(result.home).toBe(os.homedir());
  });

  it("expands a leading tilde", async () => {
    const result = await listDir("~");
    expect(result.path).toBe(os.homedir());
  });

  it("reports a symlink as its target's kind and skips dangling ones", async () => {
    fs.mkdirSync(path.join(dir, "real-dir"));
    fs.symlinkSync(path.join(dir, "real-dir"), path.join(dir, "link-to-dir"));
    fs.symlinkSync(path.join(dir, "no-such-target"), path.join(dir, "dangling"));

    const result = await listDir(dir);

    expect(result.entries).toEqual([
      { name: "link-to-dir", kind: "dir" },
      { name: "real-dir", kind: "dir" },
    ]);
  });

  it("rejects with the filesystem's own error for a missing directory", async () => {
    await expect(listDir(path.join(dir, "nope"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects with ENOTDIR for a file path", async () => {
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "");
    await expect(listDir(file)).rejects.toThrow(/ENOTDIR/);
  });
});
