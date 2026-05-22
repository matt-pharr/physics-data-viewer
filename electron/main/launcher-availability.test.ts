/**
 * launcher-availability.test.ts — Tests for launcher availability probing.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkLauncherAvailability,
  isExecutableOnPath,
  macAppInstalled,
} from "./launcher-availability";

const tempDirs: string[] = [];
let savedPath: string | undefined;

/** Create a temp dir holding one executable file; return the dir. */
function makeBinDir(binName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-avail-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, binName);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, 0o755);
  return dir;
}

afterEach(() => {
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
    savedPath = undefined;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isExecutableOnPath", () => {
  it("finds an executable on $PATH", async () => {
    const dir = makeBinDir("pdv-fake-tool");
    savedPath = process.env.PATH;
    process.env.PATH = dir;
    expect(await isExecutableOnPath("pdv-fake-tool")).toBe(true);
  });

  it("does not find an absent executable", async () => {
    const dir = makeBinDir("pdv-fake-tool");
    savedPath = process.env.PATH;
    process.env.PATH = dir;
    expect(await isExecutableOnPath("pdv-definitely-absent-xyz")).toBe(false);
  });

  it("returns false for an empty bin name", async () => {
    expect(await isExecutableOnPath("")).toBe(false);
  });
});

describe("macAppInstalled", () => {
  it("returns false for an app that does not exist", async () => {
    expect(await macAppInstalled("PdvNoSuchApp9999")).toBe(false);
  });
});

describe("checkLauncherAvailability", () => {
  it("treats kind 'none' as always available", async () => {
    expect(await checkLauncherAvailability({ kind: "none" })).toBe(true);
  });

  it("resolves a 'path' check against $PATH", async () => {
    const dir = makeBinDir("pdv-fake-tool");
    savedPath = process.env.PATH;
    process.env.PATH = dir;
    expect(
      await checkLauncherAvailability({ kind: "path", bin: "pdv-fake-tool" }),
    ).toBe(true);
    expect(
      await checkLauncherAvailability({ kind: "path", bin: "pdv-absent-xyz" }),
    ).toBe(false);
  });

  it("reports a missing macOS app as unavailable", async () => {
    expect(
      await checkLauncherAvailability({ kind: "macapp", app: "PdvNoSuchApp9999" }),
    ).toBe(false);
  });
});
