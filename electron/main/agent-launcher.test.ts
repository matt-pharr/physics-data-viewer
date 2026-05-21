/**
 * agent-launcher.test.ts — Tests for buildAgentInvocation.
 */

import { describe, expect, it } from "vitest";

import { buildAgentInvocation } from "./agent-launcher";

describe("buildAgentInvocation", () => {
  it("wraps the default command in sh -lc + the terminal preset (Linux)", () => {
    expect(
      buildAgentInvocation({
        terminal: { preset: "alacritty" },
        mcpConfigPath: "/wd/.pdv-mcp.json",
        projectRoot: "/proj",
        workingDir: "/wd",
        platform: "linux",
      }),
    ).toEqual({
      file: "alacritty",
      args: [
        "-e",
        "sh",
        "-lc",
        "cd '/proj' && exec claude --mcp-config '/wd/.pdv-mcp.json'",
      ],
    });
  });

  it("substitutes {mcpConfig}, {projectRoot} and {workingDir} with quoted paths", () => {
    const { args } = buildAgentInvocation({
      agent: { command: "myagent {mcpConfig} {projectRoot} {workingDir}" },
      terminal: { preset: "alacritty" },
      mcpConfigPath: "/wd/.pdv-mcp.json",
      projectRoot: "/proj",
      workingDir: "/wd",
      platform: "linux",
    });
    expect(args[3]).toBe(
      "cd '/proj' && exec myagent '/wd/.pdv-mcp.json' '/proj' '/wd'",
    );
  });

  it("cd's into the working directory when cwd='working'", () => {
    const { args } = buildAgentInvocation({
      agent: { cwd: "working" },
      terminal: { preset: "alacritty" },
      mcpConfigPath: "/wd/.pdv-mcp.json",
      projectRoot: "/proj",
      workingDir: "/wd",
      platform: "linux",
    });
    expect(args[3]).toBe(
      "cd '/wd' && exec claude --mcp-config '/wd/.pdv-mcp.json'",
    );
  });

  it("falls back to the working directory when cwd='project' but no project is loaded", () => {
    const { args } = buildAgentInvocation({
      terminal: { preset: "alacritty" },
      mcpConfigPath: "/wd/.pdv-mcp.json",
      projectRoot: null,
      workingDir: "/wd",
      platform: "linux",
    });
    expect(args[3]).toBe(
      "cd '/wd' && exec claude --mcp-config '/wd/.pdv-mcp.json'",
    );
  });

  it("quotes a project path containing spaces", () => {
    const { args } = buildAgentInvocation({
      terminal: { preset: "alacritty" },
      mcpConfigPath: "/wd/.pdv-mcp.json",
      projectRoot: "/Users/me/My Project",
      workingDir: "/wd",
      platform: "linux",
    });
    expect(args[3]).toBe(
      "cd '/Users/me/My Project' && exec claude --mcp-config '/wd/.pdv-mcp.json'",
    );
  });

  it("uses cmd /c on Windows and wraps in Windows Terminal", () => {
    expect(
      buildAgentInvocation({
        mcpConfigPath: "C:\\wd\\.pdv-mcp.json",
        projectRoot: "C:\\proj",
        workingDir: "C:\\wd",
        platform: "win32",
      }),
    ).toEqual({
      file: "wt.exe",
      args: [
        "new-tab",
        "cmd",
        "/c",
        `cd /d "C:\\proj" && claude --mcp-config "C:\\wd\\.pdv-mcp.json"`,
      ],
    });
  });

  it("wraps in Terminal.app via osascript on macOS by default", () => {
    const { file, args } = buildAgentInvocation({
      mcpConfigPath: "/wd/.pdv-mcp.json",
      projectRoot: "/proj",
      workingDir: "/wd",
      platform: "darwin",
    });
    expect(file).toBe("osascript");
    // The shell line is embedded as an AppleScript string literal; assert the
    // recognisable, post-escape fragments survive.
    expect(args[1]).toContain("do script");
    expect(args[1]).toContain("cd ");
    expect(args[1]).toContain("claude --mcp-config");
  });
});
