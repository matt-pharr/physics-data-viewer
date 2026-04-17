/**
 * note-files.test.ts — Unit tests for markdown note disk routing.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readNoteFile, resolveNoteFilePath, writeNoteFile } from "./note-files";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-note-files-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("note-files", () => {
  it("resolves note file paths under the tree directory", () => {
    expect(resolveNoteFilePath("/tmp/work", "notes.theory")).toBe(
      path.join("/tmp/work", "tree", "notes", "theory.md"),
    );
  });

  it("reads from the project file when project source is requested", async () => {
    const workingDir = makeTempDir();
    const projectDir = makeTempDir();
    fs.mkdirSync(path.join(workingDir, "tree", "notes"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "tree", "notes"), { recursive: true });
    fs.writeFileSync(path.join(workingDir, "tree", "notes", "theory.md"), "working copy");
    fs.writeFileSync(path.join(projectDir, "tree", "notes", "theory.md"), "project copy");

    await expect(readNoteFile({
      workingDir,
      projectDir,
      treePath: "notes.theory",
      readOptions: { source: "project" },
    })).resolves.toBe("project copy");
  });

  it("falls back to the working copy when no project file exists", async () => {
    const workingDir = makeTempDir();
    const projectDir = makeTempDir();
    fs.mkdirSync(path.join(workingDir, "tree", "notes"), { recursive: true });
    fs.writeFileSync(path.join(workingDir, "tree", "notes", "theory.md"), "working copy");

    await expect(readNoteFile({
      workingDir,
      projectDir,
      treePath: "notes.theory",
      readOptions: { source: "project" },
    })).resolves.toBe("working copy");
  });

  it("writes note content into the working directory backing file", async () => {
    const workingDir = makeTempDir();

    await writeNoteFile(workingDir, "notes.theory", "# hello");

    expect(
      fs.readFileSync(path.join(workingDir, "tree", "notes", "theory.md"), "utf8"),
    ).toBe("# hello");
  });
});
