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
  it("loads defaults when preferences.json does not exist", () => {
    const appDataDir = makeTempDir();
    const store = new ConfigStore(appDataDir);

    expect(store.getAll()).toEqual({
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
      autoRefreshNamespace: false,
      autoSaveIntervalSeconds: 300,
      defaultPackages: ["numpy", "matplotlib", "xarray", "netcdf4", "h5py"],
      defaultJuliaPackages: ["CairoMakie", "HDF5"],
      settings: {
        appearance: {
          themeName: "Dark+ (VSCode)",
          followSystemTheme: true,
          darkTheme: "Dark+ (VSCode)",
          lightTheme: "Light+ (VSCode)",
        },
      },
    });
  });

  it("loads persisted values from a valid preferences.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify(
        {
          pythonPath: "/usr/bin/python3",
          projectRoot: "/tmp/project",
          recentProjects: ["/tmp/project", "/tmp/other"],
          showPrivateVariables: true,
          showModuleVariables: true,
          showCallableVariables: false,
          theme: "dark",
          settings: {
            appearance: {
              themeName: "Solarized Dark",
              followSystemTheme: false,
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    expect(store.getAll()).toEqual({
      pythonPath: "/usr/bin/python3",
      projectRoot: "/tmp/project",
      recentProjects: ["/tmp/project", "/tmp/other"],
      showPrivateVariables: true,
      showModuleVariables: true,
      showCallableVariables: false,
      autoRefreshNamespace: false,
      autoSaveIntervalSeconds: 300,
      defaultPackages: ["numpy", "matplotlib", "xarray", "netcdf4", "h5py"],
      defaultJuliaPackages: ["CairoMakie", "HDF5"],
      theme: "dark",
      settings: {
        appearance: {
          themeName: "Solarized Dark",
          followSystemTheme: false,
        },
      },
    });
  });

  it("round-trips lastUpdateCheck across a reload (update-check throttle)", () => {
    // Regression: parseConfig used to drop lastUpdateCheck on load, so the
    // auto-updater's throttle reset on every app restart.
    const appDataDir = makeTempDir();
    const first = new ConfigStore(appDataDir);
    first.set("lastUpdateCheck", 1234567890);

    const reloaded = new ConfigStore(appDataDir);
    expect(reloaded.get("lastUpdateCheck")).toBe(1234567890);
  });

  it("drops a malformed lastUpdateCheck instead of failing the load", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({ lastUpdateCheck: "yesterday", pythonPath: "/usr/bin/python3" }),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    expect(store.get("lastUpdateCheck")).toBeUndefined();
    expect(store.get("pythonPath")).toBe("/usr/bin/python3");
  });

  it("falls back to defaults and backs up a malformed preferences.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(path.join(appDataDir, "preferences.json"), "{invalid-json", "utf8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const store = new ConfigStore(appDataDir);
    expect(store.getAll()).toEqual({
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
      autoRefreshNamespace: false,
      autoSaveIntervalSeconds: 300,
      defaultPackages: ["numpy", "matplotlib", "xarray", "netcdf4", "h5py"],
      defaultJuliaPackages: ["CairoMakie", "HDF5"],
      settings: {
        appearance: {
          themeName: "Dark+ (VSCode)",
          followSystemTheme: true,
          darkTheme: "Dark+ (VSCode)",
          lightTheme: "Light+ (VSCode)",
        },
      },
    });

    const files = fs.readdirSync(appDataDir);
    expect(files.some((name) => name.startsWith("preferences.json.corrupted-"))).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("migrates legacy pythonEditorCmd to launchers.editor.fileCommand on load", () => {
    const appDataDir = makeTempDir();
    const configPath = path.join(appDataDir, "preferences.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        pythonEditorCmd: "nvim {}",
        juliaEditorCmd: "code {}",
      }),
      "utf8",
    );

    const store = new ConfigStore(appDataDir);
    const config = store.getAll();
    expect(config.launchers?.editor?.fileCommand).toBe("nvim {}");
    expect(config.pythonEditorCmd).toBeUndefined();
    expect(config.juliaEditorCmd).toBeUndefined();

    // The legacy keys are scrubbed from the persisted file, not just the
    // in-memory view.
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk.pythonEditorCmd).toBeUndefined();
    expect(onDisk.juliaEditorCmd).toBeUndefined();
    expect(onDisk.launchers.editor.fileCommand).toBe("nvim {}");
  });

  it("migrates juliaEditorCmd when no pythonEditorCmd is present", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        juliaEditorCmd: "nvim {}",
      }),
      "utf8",
    );

    const store = new ConfigStore(appDataDir);
    const config = store.getAll();
    expect(config.launchers?.editor?.fileCommand).toBe("nvim {}");
    expect(config.juliaEditorCmd).toBeUndefined();
  });

  it("drops legacy editor keys without overwriting an existing launchers.editor.fileCommand", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        pythonEditorCmd: "nvim {}",
        launchers: { editor: { fileCommand: "code {}" } },
      }),
      "utf8",
    );

    const store = new ConfigStore(appDataDir);
    const config = store.getAll();
    // The newer launchers.editor value wins; the legacy key is just dropped.
    expect(config.launchers?.editor?.fileCommand).toBe("code {}");
    expect(config.pythonEditorCmd).toBeUndefined();
  });

  it("does not rewrite preferences.json when there is nothing to migrate", () => {
    const appDataDir = makeTempDir();
    const configPath = path.join(appDataDir, "preferences.json");
    const original = JSON.stringify({
      showPrivateVariables: true,
      showModuleVariables: false,
      showCallableVariables: false,
    });
    fs.writeFileSync(configPath, original, "utf8");
    const mtimeBefore = fs.statSync(configPath).mtimeMs;

    new ConfigStore(appDataDir);

    // No legacy keys → migration is a no-op and must not touch the file.
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.statSync(configPath).mtimeMs).toBe(mtimeBefore);
  });

  it("loads a full launchers block (terminal, editor, agent)", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        launchers: {
          terminal: { preset: "alacritty" },
          editor: { fileCommand: "nvim {}", isTuiEditor: true },
          agent: { command: "claude --mcp-config {mcpConfig}", cwd: "working" },
        },
      }),
      "utf8",
    );

    const store = new ConfigStore(appDataDir);
    expect(store.getAll().launchers).toEqual({
      terminal: { preset: "alacritty" },
      editor: { fileCommand: "nvim {}", isTuiEditor: true },
      agent: { command: "claude --mcp-config {mcpConfig}", cwd: "working" },
    });
  });

  it("rejects an invalid launchers.agent.cwd and backs up the file", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        launchers: { agent: { cwd: "nonsense" } },
      }),
      "utf8",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // parseConfig throws → loadState backs up the file and falls back to defaults.
    const store = new ConfigStore(appDataDir);
    expect(store.getAll().launchers).toBeUndefined();
    expect(
      fs.readdirSync(appDataDir).some((n) => n.startsWith("preferences.json.corrupted-")),
    ).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("treats null optional fields as cleared values", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
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

  it("loads uv.binaryPath from preferences.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({ uv: { binaryPath: "/opt/uv/uv" } }, null, 2),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    expect(store.get("uv")).toEqual({ binaryPath: "/opt/uv/uv" });
  });

  it("backs up a config whose uv field is not an object", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({ uv: "nonsense" }, null, 2),
      "utf8"
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const store = new ConfigStore(appDataDir);
    expect(store.get("uv")).toBeUndefined();
    expect(
      fs
        .readdirSync(appDataDir)
        .some((name) => name.startsWith("preferences.json.corrupted-"))
    ).toBe(true);
  });

  it("loads a custom defaultPackages list from preferences.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({ defaultPackages: ["scipy", "xarray"] }, null, 2),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    expect(store.get("defaultPackages")).toEqual(["scipy", "xarray"]);
  });

  it("loads a custom defaultJuliaPackages list from preferences.json", () => {
    const appDataDir = makeTempDir();
    fs.writeFileSync(
      path.join(appDataDir, "preferences.json"),
      JSON.stringify({ defaultJuliaPackages: ["DataFrames@1.6"] }, null, 2),
      "utf8"
    );

    const store = new ConfigStore(appDataDir);
    expect(store.get("defaultJuliaPackages")).toEqual(["DataFrames@1.6"]);
  });

});
