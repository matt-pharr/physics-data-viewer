/**
 * app-utils.test.ts — Pure-function tests for app-utils helpers.
 */

import { describe, expect, it } from "vitest";
import {
  mergeConfigUpdate,
  normalizeLoadedCodeCells,
  normalizeRecentProjects,
} from "./app-utils";
import { MAX_RECENT_PROJECTS } from "./constants";
import type { Config } from "../types/pdv";

describe("normalizeLoadedCodeCells", () => {
  it("returns a single empty tab when input is invalid (null / non-object / empty)", () => {
    for (const input of [null, undefined, "string", 5, {}, []]) {
      const result = normalizeLoadedCodeCells(input);
      expect(result.tabs).toEqual([{ id: 1, code: "" }]);
      expect(result.activeTabId).toBe(1);
    }
  });

  it("accepts the legacy array-of-tabs shape", () => {
    const result = normalizeLoadedCodeCells([
      { id: 5, code: "a" },
      { id: 6, code: "b" },
    ]);
    expect(result.tabs).toEqual([
      { id: 5, code: "a" },
      { id: 6, code: "b" },
    ]);
    expect(result.activeTabId).toBe(5);
  });

  it("accepts the new {tabs, activeTabId} shape and preserves names", () => {
    const result = normalizeLoadedCodeCells({
      tabs: [{ id: 1, code: "x", name: "intro" }],
      activeTabId: 1,
    });
    expect(result.tabs).toEqual([{ id: 1, code: "x", name: "intro" }]);
    expect(result.activeTabId).toBe(1);
  });

  it("falls back to the first tab id when the requested activeTabId is not present", () => {
    const result = normalizeLoadedCodeCells({
      tabs: [{ id: 7, code: "" }],
      activeTabId: 99,
    });
    expect(result.activeTabId).toBe(7);
  });

  it("synthesises sequential ids when missing", () => {
    const result = normalizeLoadedCodeCells({
      tabs: [{ code: "a" }, { code: "b" }],
    });
    expect(result.tabs.map((t) => t.id)).toEqual([1, 2]);
  });

  it("drops non-object entries from the raw tabs list", () => {
    const result = normalizeLoadedCodeCells({
      tabs: [{ code: "ok" }, null, "hello", 5, { code: "ok2" }],
    });
    expect(result.tabs).toHaveLength(2);
  });
});

describe("normalizeRecentProjects", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeRecentProjects(null)).toEqual([]);
    expect(normalizeRecentProjects("a/b")).toEqual([]);
    expect(normalizeRecentProjects(undefined)).toEqual([]);
  });

  it("trims, dedupes, and preserves order", () => {
    expect(
      normalizeRecentProjects([" /a ", "/b", "/a", "/b", " /c "]),
    ).toEqual(["/a", "/b", "/c"]);
  });

  it("caps the result at MAX_RECENT_PROJECTS", () => {
    const input = Array.from({ length: MAX_RECENT_PROJECTS + 5 }, (_, i) => `/p${i}`);
    expect(normalizeRecentProjects(input).length).toBe(MAX_RECENT_PROJECTS);
  });

  it("skips empty / whitespace-only / non-string entries", () => {
    expect(normalizeRecentProjects(["", "   ", null, 5, "/ok"])).toEqual(["/ok"]);
  });
});

describe("mergeConfigUpdate", () => {
  it("shallow-merges top-level keys", () => {
    const base = { pythonPath: "/old", trusted: false } as Config;
    const merged = mergeConfigUpdate(base, { pythonPath: "/new" });
    expect(merged.pythonPath).toBe("/new");
    expect(merged.trusted).toBe(false);
  });

  it("deep-merges settings.appearance, preserving sibling keys", () => {
    const base = {
      settings: {
        editor: { fontSize: 14 },
        appearance: { themeName: "dark", followSystemTheme: false },
      },
    } as unknown as Config;
    const merged = mergeConfigUpdate(base, {
      settings: {
        appearance: { themeName: "light" },
      } as unknown as Config["settings"],
    });
    expect(merged.settings?.appearance?.themeName).toBe("light");
    // Sibling field preserved.
    expect(merged.settings?.appearance?.followSystemTheme).toBe(false);
    // Sibling settings group preserved.
    expect(merged.settings?.editor?.fontSize).toBe(14);
  });

  it("survives missing settings on either side", () => {
    const merged = mergeConfigUpdate({} as Config, { theme: "dark" });
    expect(merged.theme).toBe("dark");
    expect(merged.settings).toEqual({ appearance: {} });
  });

  it("deep-merges the launchers subtree, preserving the agent slot", () => {
    // The General tab writes only terminal + editor; the Agents-tab `agent`
    // slot must survive in the in-memory copy (mirrors the main-side merge).
    const base = {
      launchers: {
        terminal: { preset: 'terminal-app' },
        agent: { command: 'claude', cwd: 'working' },
      },
    } as unknown as Config;
    const merged = mergeConfigUpdate(base, {
      launchers: {
        terminal: { preset: 'iterm2' },
        editor: { fileCommand: 'code {}' },
      },
    } as unknown as Partial<Config>);
    expect(merged.launchers?.terminal?.preset).toBe('iterm2');
    expect(merged.launchers?.editor?.fileCommand).toBe('code {}');
    expect(merged.launchers?.agent?.command).toBe('claude');
  });

  it("leaves launchers untouched when an update omits it", () => {
    const base = {
      launchers: { agent: { command: 'claude' } },
    } as unknown as Config;
    const merged = mergeConfigUpdate(base, { theme: 'dark' });
    expect(merged.launchers?.agent?.command).toBe('claude');
  });
});
