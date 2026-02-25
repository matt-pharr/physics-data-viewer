/**
 * config.test.ts — Unit tests for ConfigStore persistence and recovery.
 *
 * Verifies that ConfigStore:
 * 1. Loads defaults when no config file exists.
 * 2. Loads persisted values from a valid config.json file.
 * 3. Recovers safely from malformed/invalid config files without crashing.
 * 4. Accepts null optional fields in on-disk config as "cleared" values.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ConfigStore } from "./config";

const tempDirs: string[] = [];

/**
 * Create and track a temporary directory for one test case.
 *
 * @returns Absolute temporary directory path.
 */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("ConfigStore", () => {
  it("loads defaults when config.json does not exist", () => {
    const appDataDir = makeTempDir();
    const store = new ConfigStore(appDataDir);

    expect(store.getAll()).toEqual({
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
    });
  });

  it("loads persisted values from a valid config.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "config.json"),
      JSON.stringify(
        {
          pythonPath: "/usr/bin/python3",
          showPrivateVariables: true,
          showModuleVariables: true,
          showCallableVariables: false,
          theme: "dark",
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    expect(store.getAll()).toEqual({
      pythonPath: "/usr/bin/python3",
      showPrivateVariables: true,
      showModuleVariables: true,
      showCallableVariables: false,
      theme: "dark",
    });
  });

  it("falls back to defaults and backs up a malformed config.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(path.join(appDataDir, "config.json"), "{invalid-json", "utf8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const store = new ConfigStore(appDataDir);
    expect(store.getAll()).toEqual({
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
    });

    const files = fs.readdirSync(appDataDir);
    expect(files.some((name) => name.startsWith("config.json.corrupted-"))).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("treats null optional fields as cleared values", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "config.json"),
      JSON.stringify(
        {
          pythonPath: null,
          lastProjectDir: null,
          theme: null,
          showPrivateVariables: true,
          showModuleVariables: false,
          showCallableVariables: true,
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    const config = store.getAll();
    expect(config.pythonPath).toBeUndefined();
    expect(config.lastProjectDir).toBeUndefined();
    expect(config.theme).toBeUndefined();
    expect(config.showPrivateVariables).toBe(true);
    expect(config.showModuleVariables).toBe(false);
    expect(config.showCallableVariables).toBe(true);
  });
});
