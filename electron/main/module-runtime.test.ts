/**
 * module-runtime.test.ts — Unit tests for module runtime helpers.
 */

import { describe, expect, it, vi } from "vitest";

import type { ModuleManager } from "./module-manager";
import type { ProjectModuleImport } from "./project-manager";
import { buildModulesSetupPayload, toPythonArgumentValue } from "./module-runtime";

describe("toPythonArgumentValue", () => {
  it("preserves numeric literals for numeric text inputs", () => {
    expect(toPythonArgumentValue("5")).toBe("5");
    expect(toPythonArgumentValue("-3.14e+2")).toBe("-3.14e+2");
  });

  it("returns Python literals for primitive boolean and number values", () => {
    expect(toPythonArgumentValue(true)).toBe("True");
    expect(toPythonArgumentValue(false)).toBe("False");
    expect(toPythonArgumentValue(12.5)).toBe("12.5");
  });

  it("quotes string expressions to prevent code injection", () => {
    expect(toPythonArgumentValue("5); __import__('os').system('evil')#")).toBe(
      "'5); __import__(\\'os\\').system(\\'evil\\')#'"
    );
  });

  it("produces valid Python string literals for plain strings", () => {
    expect(toPythonArgumentValue("RK45")).toBe("'RK45'");
    expect(toPythonArgumentValue("hello world")).toBe("'hello world'");
  });

  it("escapes backslashes in string values", () => {
    expect(toPythonArgumentValue("path\\to\\file")).toBe("'path\\\\to\\\\file'");
  });

  it("escapes newlines, carriage returns, and tabs in string values", () => {
    expect(toPythonArgumentValue("line1\nline2")).toBe("'line1\\nline2'");
    expect(toPythonArgumentValue("col1\tcol2")).toBe("'col1\\tcol2'");
    expect(toPythonArgumentValue("a\r\nb")).toBe("'a\\r\\nb'");
  });

  it("returns null for empty string input", () => {
    expect(toPythonArgumentValue("   ")).toBeNull();
  });
});

describe("buildModulesSetupPayload", () => {
  function makeMockModuleManager(
    overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
  ): { moduleManager: ModuleManager; getModuleSetupInfo: ReturnType<typeof vi.fn> } {
    const getModuleSetupInfo = overrides.getModuleSetupInfo ?? vi.fn();
    const moduleManager = { getModuleSetupInfo } as unknown as ModuleManager;
    return { moduleManager, getModuleSetupInfo };
  }

  it("emits { alias } for in-session modules and never reads the installed manifest", async () => {
    const { moduleManager, getModuleSetupInfo } = makeMockModuleManager();
    const modules: ProjectModuleImport[] = [
      { module_id: "toy", alias: "toy", version: "0.1.0", origin: "in_session" },
    ];

    const payload = await buildModulesSetupPayload(moduleManager, modules, "/tmp/proj");

    expect(payload).toEqual({ modules: [{ alias: "toy" }] });
    expect(getModuleSetupInfo).not.toHaveBeenCalled();
  });

  it("emits { alias, entry_point } for imported modules via getModuleSetupInfo", async () => {
    const getModuleSetupInfo = vi.fn().mockResolvedValue({
      installPath: "/store/n_pendulum",
      entryPoint: "n_pendulum",
    });
    const { moduleManager } = makeMockModuleManager({ getModuleSetupInfo });
    const modules: ProjectModuleImport[] = [
      {
        module_id: "n_pendulum",
        alias: "n_pendulum",
        version: "2.0.0",
        origin: "imported",
      },
    ];

    const payload = await buildModulesSetupPayload(moduleManager, modules, "/tmp/proj");

    expect(payload).toEqual({
      modules: [{ alias: "n_pendulum", entry_point: "n_pendulum" }],
    });
    expect(getModuleSetupInfo).toHaveBeenCalledTimes(1);
    expect(getModuleSetupInfo).toHaveBeenCalledWith("n_pendulum", "/tmp/proj");
  });

  it("omits entry_point when the imported module has none", async () => {
    const getModuleSetupInfo = vi
      .fn()
      .mockResolvedValue({ installPath: "/store/x" });
    const { moduleManager } = makeMockModuleManager({ getModuleSetupInfo });
    const modules: ProjectModuleImport[] = [
      { module_id: "x", alias: "x", version: "0.1.0", origin: "imported" },
    ];

    const payload = await buildModulesSetupPayload(moduleManager, modules, null);

    expect(payload.modules).toHaveLength(1);
    expect(payload.modules[0]).toEqual({ alias: "x" });
  });

  it("falls back to { alias } when getModuleSetupInfo throws — walker still wires from the live tree", async () => {
    const getModuleSetupInfo = vi
      .fn()
      .mockRejectedValue(new Error("manifest missing"));
    const { moduleManager } = makeMockModuleManager({ getModuleSetupInfo });
    const modules: ProjectModuleImport[] = [
      { module_id: "broken", alias: "broken", version: "0.1.0", origin: "imported" },
    ];

    const payload = await buildModulesSetupPayload(moduleManager, modules, null);

    expect(payload).toEqual({ modules: [{ alias: "broken" }] });
  });

  it("handles a mix of origins in one call", async () => {
    const getModuleSetupInfo = vi
      .fn()
      .mockResolvedValue({ installPath: "/store/imp", entryPoint: "imp" });
    const { moduleManager } = makeMockModuleManager({ getModuleSetupInfo });
    const modules: ProjectModuleImport[] = [
      { module_id: "imp", alias: "imp", version: "1.0.0", origin: "imported" },
      { module_id: "sess", alias: "sess", version: "0.1.0", origin: "in_session" },
    ];

    const payload = await buildModulesSetupPayload(moduleManager, modules, null);

    expect(payload).toEqual({
      modules: [
        { alias: "imp", entry_point: "imp" },
        { alias: "sess" },
      ],
    });
    expect(getModuleSetupInfo).toHaveBeenCalledTimes(1);
  });
});
