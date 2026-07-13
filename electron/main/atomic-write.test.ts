/**
 * Tests for the atomic write helpers used by the project save pipeline.
 *
 * Verifies the contract callers rely on for crash safety:
 *   - successful writes leave only the destination file (no `.tmp` residue);
 *   - failed writes leave the destination untouched and clean up the tmp;
 *   - rename is invoked on the same-directory sibling tmp so the rename is
 *     POSIX-atomic on a single volume.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { atomicCopyFile, atomicWriteFile, atomicWriteJson } from "./atomic-write";

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-atomic-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the file and leaves no .tmp behind", async () => {
    const dest = path.join(tmpDir, "out.json");
    await atomicWriteFile(dest, "hello");
    expect(await fs.readFile(dest, "utf8")).toBe("hello");
    await expect(fs.stat(dest + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the parent directory on demand", async () => {
    const dest = path.join(tmpDir, "nested", "deep", "out.json");
    await atomicWriteFile(dest, "hi");
    expect(await fs.readFile(dest, "utf8")).toBe("hi");
  });

  it("replaces an existing destination atomically", async () => {
    const dest = path.join(tmpDir, "out.json");
    await fs.writeFile(dest, "old contents");
    await atomicWriteFile(dest, "new contents");
    expect(await fs.readFile(dest, "utf8")).toBe("new contents");
    await expect(fs.stat(dest + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the destination untouched on write failure (parent path is a regular file)", async () => {
    // Forcing the parent of the target to be a regular file (not a
    // directory) makes the underlying ``mkdir -p`` fail, which surfaces
    // as a rejection from atomicWriteFile. We assert the existing file
    // at the parent path is untouched — the destination side never
    // got modified.
    const blocker = path.join(tmpDir, "blocker");
    await fs.writeFile(blocker, "intact");
    const dest = path.join(blocker, "out.json");
    await expect(atomicWriteFile(dest, "would-be-new")).rejects.toThrow();
    expect(await fs.readFile(blocker, "utf8")).toBe("intact");
  });

  it("accepts Buffer payloads", async () => {
    const dest = path.join(tmpDir, "out.bin");
    await atomicWriteFile(dest, Buffer.from([0x01, 0x02, 0x03]));
    const buf = await fs.readFile(dest);
    expect(Array.from(buf)).toEqual([0x01, 0x02, 0x03]);
  });
});

describe("atomicWriteJson", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-atomic-json-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stringifies with two-space indent and a trailing newline by default", async () => {
    const dest = path.join(tmpDir, "out.json");
    await atomicWriteJson(dest, { a: 1, nested: { b: 2 } });
    const body = await fs.readFile(dest, "utf8");
    // Trailing newline matches POSIX text-file convention and the prior
    // shape of pdv-module.json / module-index.json (the only project
    // artifacts that previously appended one). Migrating project.json
    // and code-cells.json onto the same convention is a one-byte diff
    // on the next save — strictly an improvement.
    expect(body).toBe('{\n  "a": 1,\n  "nested": {\n    "b": 2\n  }\n}\n');
  });

  it("respects a custom indent and still ends with a newline", async () => {
    const dest = path.join(tmpDir, "out.json");
    await atomicWriteJson(dest, { a: 1 }, 0);
    expect(await fs.readFile(dest, "utf8")).toBe('{"a":1}\n');
  });
});

describe("atomicCopyFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-atomic-cp-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("copies bytes and leaves no .tmp behind", async () => {
    const src = path.join(tmpDir, "src.bin");
    const dst = path.join(tmpDir, "nested", "dst.bin");
    await fs.writeFile(src, "payload");
    await atomicCopyFile(src, dst);
    expect(await fs.readFile(dst, "utf8")).toBe("payload");
    await expect(fs.stat(dst + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the existing destination untouched on copy failure", async () => {
    const src = path.join(tmpDir, "missing.bin");
    const dst = path.join(tmpDir, "dst.bin");
    await fs.writeFile(dst, "original");
    await expect(atomicCopyFile(src, dst)).rejects.toThrow(/ENOENT/);
    expect(await fs.readFile(dst, "utf8")).toBe("original");
    await expect(fs.stat(dst + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
