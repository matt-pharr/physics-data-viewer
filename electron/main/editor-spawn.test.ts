/**
 * editor-spawn.test.ts — Tests for terminal-preset expansion and editor wrap.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  buildEditorSpawn,
  defaultTerminalPreset,
  escapeForAppleScriptString,
  expandTerminalTemplate,
  isTerminalEditorCommand,
  resolveEditorSpawn,
  tokenizeShellLike,
} from "./editor-spawn";

describe("buildEditorSpawn", () => {
  it("uses VS Code default when command is undefined", () => {
    expect(buildEditorSpawn(undefined, "/tmp/foo.py")).toEqual({
      file: "code",
      args: ["/tmp/foo.py"],
    });
  });

  it("substitutes the {} placeholder when present", () => {
    expect(buildEditorSpawn("nvim {}", "/tmp/foo.py")).toEqual({
      file: "nvim",
      args: ["/tmp/foo.py"],
    });
  });

  it("appends the file path when no placeholder is present", () => {
    expect(buildEditorSpawn("subl --wait", "/tmp/foo.py")).toEqual({
      file: "subl",
      args: ["--wait", "/tmp/foo.py"],
    });
  });
});

describe("tokenizeShellLike", () => {
  it("splits on unquoted whitespace", () => {
    expect(tokenizeShellLike("alacritty -e vim foo.py")).toEqual([
      "alacritty",
      "-e",
      "vim",
      "foo.py",
    ]);
  });

  it("keeps single-quoted strings as one token without escape processing", () => {
    expect(
      tokenizeShellLike(
        `osascript -e 'tell application "Terminal" to do script {cmdstr}'`,
      ),
    ).toEqual([
      "osascript",
      "-e",
      `tell application "Terminal" to do script {cmdstr}`,
    ]);
  });

  it("keeps double-quoted strings as one token, honouring \\\" and \\\\", () => {
    expect(tokenizeShellLike(`echo "hello \\"world\\" \\\\foo"`)).toEqual([
      "echo",
      `hello "world" \\foo`,
    ]);
  });

  it("preserves a custom-template path with spaces in single quotes", () => {
    expect(
      tokenizeShellLike(
        `'/Applications/My Terminal.app/Contents/MacOS/MyTerm' -e {cmd}`,
      ),
    ).toEqual([
      "/Applications/My Terminal.app/Contents/MacOS/MyTerm",
      "-e",
      "{cmd}",
    ]);
  });

  it("handles backslash-escaped spaces outside quotes", () => {
    expect(tokenizeShellLike("/path/with\\ space -e {cmd}")).toEqual([
      "/path/with space",
      "-e",
      "{cmd}",
    ]);
  });

  it("throws on an unterminated single quote", () => {
    expect(() => tokenizeShellLike("foo 'bar")).toThrow(/Unterminated quote/);
  });

  it("throws on an unterminated double quote", () => {
    expect(() => tokenizeShellLike('foo "bar')).toThrow(/Unterminated quote/);
  });
});

describe("escapeForAppleScriptString", () => {
  it("wraps a simple argv in shell-quoted form inside AppleScript double quotes", () => {
    expect(escapeForAppleScriptString(["vim", "/tmp/foo.py"])).toBe(
      `"'vim' '/tmp/foo.py'"`,
    );
  });

  it("escapes a single quote in a path using POSIX `'\\''` quoting", () => {
    // Backslash inside the shell-quoting must then be doubled for the
    // AppleScript string layer.
    expect(escapeForAppleScriptString(["vim", "/tmp/it's a test.py"])).toBe(
      `"'vim' '/tmp/it'\\\\''s a test.py'"`,
    );
  });

  it("escapes embedded double-quotes for the AppleScript literal", () => {
    expect(escapeForAppleScriptString(["vim", `/tmp/with"quote.py`])).toBe(
      `"'vim' '/tmp/with\\"quote.py'"`,
    );
  });

  it("escapes embedded backslashes by doubling them", () => {
    // POSIX shell single quotes leave backslashes alone, so a literal
    // `\` in the data must be escaped only for the AppleScript layer.
    expect(escapeForAppleScriptString(["vim", `C:\\Users\\me.py`])).toBe(
      `"'vim' 'C:\\\\Users\\\\me.py'"`,
    );
  });

  it("uses '' for empty args", () => {
    expect(escapeForAppleScriptString(["vim", ""])).toBe(`"'vim' ''"`);
  });
});

describe("expandTerminalTemplate", () => {
  it("splices {cmd} as multiple argv tokens", () => {
    expect(
      expandTerminalTemplate("alacritty -e {cmd}", "vim", ["/tmp/foo.py"]),
    ).toEqual({
      file: "alacritty",
      args: ["-e", "vim", "/tmp/foo.py"],
    });
  });

  it("substitutes {cmdstr} inside a surrounding token", () => {
    const { file, args } = expandTerminalTemplate(
      `osascript -e 'tell application "Terminal" to do script {cmdstr}'`,
      "vim",
      ["/tmp/foo.py"],
    );
    expect(file).toBe("osascript");
    expect(args).toEqual([
      "-e",
      `tell application "Terminal" to do script "'vim' '/tmp/foo.py'"`,
    ]);
  });

  it("preserves a quoted multi-word path from a custom template", () => {
    const { file, args } = expandTerminalTemplate(
      `'/Applications/My Terminal.app/Contents/MacOS/MyTerm' -e {cmd}`,
      "vim",
      ["/tmp/foo.py"],
    );
    expect(file).toBe(
      "/Applications/My Terminal.app/Contents/MacOS/MyTerm",
    );
    expect(args).toEqual(["-e", "vim", "/tmp/foo.py"]);
  });

  it("throws when the template tokenizes to nothing", () => {
    expect(() => expandTerminalTemplate("", "vim", ["/tmp/foo.py"])).toThrow();
  });
});

describe("isTerminalEditorCommand", () => {
  it("recognises common TUI editors", () => {
    expect(isTerminalEditorCommand("vim")).toBe(true);
    expect(isTerminalEditorCommand("nvim")).toBe(true);
    expect(isTerminalEditorCommand("/usr/local/bin/nano")).toBe(true);
    expect(isTerminalEditorCommand("NVIM.EXE")).toBe(true);
  });

  it("rejects GUI editors", () => {
    expect(isTerminalEditorCommand("code")).toBe(false);
    expect(isTerminalEditorCommand("subl")).toBe(false);
    expect(isTerminalEditorCommand("nvim-qt")).toBe(false);
  });
});

describe("defaultTerminalPreset", () => {
  it("returns terminal-app on darwin", () => {
    expect(defaultTerminalPreset("darwin")).toBe("terminal-app");
  });
  it("returns windows-terminal on win32", () => {
    expect(defaultTerminalPreset("win32")).toBe("windows-terminal");
  });
  it("returns x-terminal-emulator on linux", () => {
    expect(defaultTerminalPreset("linux")).toBe("x-terminal-emulator");
  });
});

describe("resolveEditorSpawn", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns the spec unchanged for a GUI editor", () => {
    expect(resolveEditorSpawn("code", ["/tmp/foo.py"])).toEqual({
      file: "code",
      args: ["/tmp/foo.py"],
    });
  });

  it("does not wrap when preset='none', even for a TUI editor (logs warning)", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "none" },
      }),
    ).toEqual({ file: "vim", args: ["/tmp/foo.py"] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("without a terminal wrapper"),
    );
  });

  it("wraps with the alacritty preset on Linux (bare CLI)", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "alacritty" },
        platform: "linux",
      }),
    ).toEqual({
      file: "alacritty",
      args: ["-e", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with the alacritty preset on macOS via `open -na`", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "alacritty" },
        platform: "darwin",
      }),
    ).toEqual({
      file: "open",
      args: ["-na", "Alacritty", "--args", "-e", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with the ghostty preset on Linux (bare CLI)", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "ghostty" },
        platform: "linux",
      }),
    ).toEqual({
      file: "ghostty",
      args: ["-e", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with the ghostty preset on macOS via `open -na Ghostty`", () => {
    // This is the regression fix: bare `ghostty` isn't on PATH for the
    // default macOS install, so we route through `open -na` which finds
    // the .app bundle by name.
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "ghostty" },
        platform: "darwin",
      }),
    ).toEqual({
      file: "open",
      args: ["-na", "Ghostty", "--args", "-e", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with the kitty preset on macOS via `open -na kitty`", () => {
    expect(
      resolveEditorSpawn("vim", ["-c", ":set foo", "/tmp/foo.py"], {
        terminal: { preset: "kitty" },
        platform: "darwin",
      }),
    ).toEqual({
      file: "open",
      args: ["-na", "kitty", "--args", "--", "vim", "-c", ":set foo", "/tmp/foo.py"],
    });
  });

  it("wraps with the kitty preset on Linux using -- to avoid flag collisions", () => {
    expect(
      resolveEditorSpawn("vim", ["-c", ":set foo", "/tmp/foo.py"], {
        terminal: { preset: "kitty" },
        platform: "linux",
      }),
    ).toEqual({
      file: "kitty",
      args: ["--", "vim", "-c", ":set foo", "/tmp/foo.py"],
    });
  });

  it("wraps with the wezterm preset on macOS via `open -na WezTerm`", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "wezterm" },
        platform: "darwin",
      }),
    ).toEqual({
      file: "open",
      args: ["-na", "WezTerm", "--args", "start", "--", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with the x-terminal-emulator preset on Linux", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "x-terminal-emulator" },
        platform: "linux",
      }),
    ).toEqual({
      file: "x-terminal-emulator",
      args: ["-e", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with the windows-terminal preset on Windows", () => {
    expect(
      resolveEditorSpawn("vim", ["C:\\Users\\me\\foo.py"], {
        terminal: { preset: "windows-terminal" },
        platform: "win32",
      }),
    ).toEqual({
      file: "wt.exe",
      args: ["new-tab", "vim", "C:\\Users\\me\\foo.py"],
    });
  });

  it("wraps with the gnome-terminal preset using --", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "gnome-terminal" },
        platform: "linux",
      }),
    ).toEqual({
      file: "gnome-terminal",
      args: ["--", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with konsole using -e --", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "konsole" },
        platform: "linux",
      }),
    ).toEqual({
      file: "konsole",
      args: ["-e", "--", "vim", "/tmp/foo.py"],
    });
  });

  it("wraps with terminal-app via osascript, appends `; exit`, drops redundant `activate`", () => {
    // `do script` already raises the window; the previous separate
    // `tell application "Terminal" to activate` clause caused a redundant
    // empty window on some macOS configurations. `& "; exit"` makes the
    // inner shell exit on :q so users with "Close if exited cleanly"
    // profiles get a clean window close.
    const { file, args } = resolveEditorSpawn("vim", ["/tmp/foo.py"], {
      terminal: { preset: "terminal-app" },
      platform: "darwin",
    });
    expect(file).toBe("osascript");
    expect(args).toEqual([
      "-e",
      `tell application "Terminal" to do script "'vim' '/tmp/foo.py'" & "; exit"`,
    ]);
  });

  it("wraps with iterm2 via osascript and appends `; exit`", () => {
    const { file, args } = resolveEditorSpawn("vim", ["/tmp/foo.py"], {
      terminal: { preset: "iterm2" },
      platform: "darwin",
    });
    expect(file).toBe("osascript");
    expect(args).toEqual([
      "-e",
      `tell application "iTerm" to create window with default profile command "'vim' '/tmp/foo.py'" & "; exit"`,
    ]);
  });

  it("falls back to the platform default when a preset has no template for this platform", () => {
    // e.g. a 'gnome-terminal' preset persisted on Linux, then PDV opens
    // on macOS — we expand the macOS default (terminal-app) instead of
    // silently dropping the wrapper.
    const result = resolveEditorSpawn("vim", ["/tmp/foo.py"], {
      terminal: { preset: "gnome-terminal" },
      platform: "darwin",
    });
    expect(result.file).toBe("osascript");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no template for platform 'darwin'"),
    );
  });

  it("uses a custom template when preset='custom'", () => {
    expect(
      resolveEditorSpawn("vim", ["/tmp/foo.py"], {
        terminal: { preset: "custom", customTemplate: "mytty --run {cmd}" },
      }),
    ).toEqual({
      file: "mytty",
      args: ["--run", "vim", "/tmp/foo.py"],
    });
  });

  it("falls back to the platform default when preset='custom' with empty template", () => {
    const result = resolveEditorSpawn("vim", ["/tmp/foo.py"], {
      terminal: { preset: "custom", customTemplate: "" },
    });
    // The fallback depends on the test runner's platform; just assert that
    // it didn't return the bare unwrapped command, and that a warning fired.
    expect(result.file).not.toBe("vim");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no template for platform"),
    );
  });

  it("falls back to the platform-default preset when opts.terminal is unset", () => {
    const result = resolveEditorSpawn("vim", ["/tmp/foo.py"]);
    if (process.platform === "darwin") {
      expect(result.file).toBe("osascript");
    } else if (process.platform === "win32") {
      expect(result.file).toBe("wt.exe");
    } else {
      expect(result.file).toBe("x-terminal-emulator");
    }
  });

  it("survives a path with embedded single-quotes through the terminal-app AppleScript layer", () => {
    const { file, args } = resolveEditorSpawn(
      "vim",
      ["/tmp/it's a test.py"],
      { terminal: { preset: "terminal-app" }, platform: "darwin" },
    );
    expect(file).toBe("osascript");
    // After AppleScript parses `\\` → `\`, the inner Terminal.app shell sees
    // `'vim' '/tmp/it'\''s a test.py'; exit` — bash reconstructs the editor
    // argv as ['vim', "/tmp/it's a test.py"] and exits the shell on :q.
    expect(args[1]).toBe(
      `tell application "Terminal" to do script "'vim' '/tmp/it'\\\\''s a test.py'" & "; exit"`,
    );
  });
});
