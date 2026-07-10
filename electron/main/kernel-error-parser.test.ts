/**
 * kernel-error-parser.test.ts — Unit tests for buildExecutionError().
 *
 * The module is pure (no I/O), so these tests drive it directly with realistic
 * Python and Julia traceback fixtures and assert on the parsed location, the
 * user-vs-internal frame ranking, the code-cell blank-line adjustment, and the
 * composed human-readable summary.
 */

import { describe, it, expect } from "vitest";
import { buildExecutionError } from "./kernel-error-parser";
import type { KernelExecutionOrigin } from "./kernel-manager";

const cellOrigin = (label?: string): KernelExecutionOrigin => ({
  kind: "code-cell",
  label,
});

describe("buildExecutionError — name/message basics", () => {
  it("composes 'Name: message' with no traceback and no location", () => {
    const err = buildExecutionError("ValueError", "bad value", []);
    expect(err.name).toBe("ValueError");
    expect(err.message).toBe("bad value");
    expect(err.summary).toBe("ValueError: bad value");
    expect(err.location).toBeUndefined();
  });

  it("defaults a blank name to 'Error'", () => {
    const err = buildExecutionError("", "boom", []);
    expect(err.name).toBe("Error");
    expect(err.summary).toBe("Error: boom");
  });

  it("omits the message segment when the message is empty", () => {
    const err = buildExecutionError("KeyboardInterrupt", "", []);
    expect(err.summary).toBe("KeyboardInterrupt");
  });
});

describe("buildExecutionError — Python traceback locations", () => {
  it("extracts file and line from a File \"...\", line N frame", () => {
    const tb = [
      "Traceback (most recent call last):",
      '  File "/home/me/analysis.py", line 42, in analyze',
      "    boom()",
      "ValueError: kaput",
    ];
    const err = buildExecutionError("ValueError", "kaput", tb);
    expect(err.location).toEqual({ file: "/home/me/analysis.py", line: 42, column: undefined });
    expect(err.summary).toBe("ValueError: kaput (/home/me/analysis.py, line 42)");
  });

  it("parses a Cell In[N] frame and shows only the line (synthetic file hidden)", () => {
    const tb = [
      "Cell In[5], line 3, in <module>",
      "    undefined_name",
      "NameError: name 'undefined_name' is not defined",
    ];
    const err = buildExecutionError("NameError", "name 'undefined_name' is not defined", tb);
    expect(err.location?.line).toBe(3);
    expect(err.location?.file).toBe("<ipython-cell>");
    // Synthetic "<...>" files are not repeated in the location text.
    expect(err.summary).toContain("(line 3)");
    expect(err.summary).not.toContain("<ipython-cell>");
  });

  it("picks up a caret column for a SyntaxError frame", () => {
    const tb = [
      '  File "<ipython-input-1>", line 1',
      "    x = = 5",
      "        ^",
      "SyntaxError: invalid syntax",
    ];
    const err = buildExecutionError("SyntaxError", "invalid syntax", tb);
    expect(err.location?.line).toBe(1);
    expect(err.location?.column).toBe(9);
  });

  it("strips ANSI escape codes before parsing", () => {
    const tb = [
      "[0;31m---------------------------------------------------------------------------[0m",
      '[0;32m  File [0m"[0;34m/tmp/x.py[0m", line [0;36m7[0m',
      "[0;31mRuntimeError[0m: nope",
    ];
    const err = buildExecutionError("RuntimeError", "nope", tb);
    expect(err.location?.file).toBe("/tmp/x.py");
    expect(err.location?.line).toBe(7);
  });

  it("prefers a user frame over an internal /pdv/ frame", () => {
    const tb = [
      "Traceback (most recent call last):",
      '  File "/opt/pdv/handlers/script.py", line 10, in run',
      "    user_fn()",
      '  File "/home/me/model.py", line 88, in user_fn',
      "    1 / 0",
      "ZeroDivisionError: division by zero",
    ];
    const err = buildExecutionError("ZeroDivisionError", "division by zero", tb);
    expect(err.location?.file).toBe("/home/me/model.py");
    expect(err.location?.line).toBe(88);
  });
});

describe("buildExecutionError — Julia traceback locations", () => {
  it("parses an In[N]:line:col cell reference with inline column", () => {
    const tb = ["In[10]:1:20", "ERROR: UndefVarError: `q` not defined"];
    const err = buildExecutionError("UndefVarError", "`q` not defined", tb);
    expect(err.location?.line).toBe(1);
    expect(err.location?.column).toBe(20);
  });

  it("parses an @ file.jl:line frame", () => {
    const tb = [
      "ERROR: MethodError: no method matching f()",
      "Stacktrace:",
      " [1] top-level scope",
      "   @ ./mymod.jl:42",
    ];
    const err = buildExecutionError("MethodError", "no method matching f()", tb);
    expect(err.location?.file).toBe("./mymod.jl");
    expect(err.location?.line).toBe(42);
  });

  it("decodes backslash-escaped literals in the summary message", () => {
    const err = buildExecutionError("ErrorException", 'bad \\"quoted\\" value', []);
    // The raw message is preserved; the summary is decoded for display.
    expect(err.message).toBe('bad \\"quoted\\" value');
    expect(err.summary).toBe('ErrorException: bad "quoted" value');
  });
});

describe("buildExecutionError — location fallbacks", () => {
  it("falls back to an evalue (file, line N) when there are no frames", () => {
    const err = buildExecutionError(
      "SyntaxError",
      "invalid syntax (setup.py, line 5)",
      ["SyntaxError: invalid syntax"]
    );
    expect(err.location?.file).toBe("setup.py");
    expect(err.location?.line).toBe(5);
  });

  it("falls back to a ----> N arrow line when no frame matches", () => {
    const tb = ["Some non-standard traceback", "----> 12 do_thing()", "Boom: happened"];
    const err = buildExecutionError("Boom", "happened", tb);
    expect(err.location?.line).toBe(12);
  });
});

describe("buildExecutionError — code-cell blank-line adjustment", () => {
  it("shifts a cell line number by the count of leading blank lines", () => {
    const tb = ["Cell In[1], line 1, in <module>", "NameError: name 'x' is not defined"];
    const code = "\n\nx";
    const err = buildExecutionError(
      "NameError",
      "name 'x' is not defined",
      tb,
      cellOrigin("Tab 1"),
      code
    );
    // 2 leading blank lines → reported line 1 becomes 3.
    expect(err.location?.line).toBe(3);
  });

  it("does not adjust when no code is supplied", () => {
    const tb = ["Cell In[1], line 1, in <module>", "NameError: name 'x' is not defined"];
    const err = buildExecutionError(
      "NameError",
      "name 'x' is not defined",
      tb,
      cellOrigin("Tab 1")
    );
    expect(err.location?.line).toBe(1);
  });

  it("does not adjust a real file path even for a code-cell origin", () => {
    const tb = ['  File "/abs/real.py", line 4, in run', "ValueError: x"];
    const err = buildExecutionError("ValueError", "x", tb, cellOrigin("Tab 1"), "\n\ncode");
    expect(err.location?.line).toBe(4);
  });
});

describe("buildExecutionError — summary source/location composition", () => {
  it("prefixes source and location when both are present", () => {
    const tb = ["Cell In[1], line 2, in <module>", "NameError: name 'x' is not defined"];
    const err = buildExecutionError(
      "NameError",
      "name 'x' is not defined",
      tb,
      cellOrigin("Tab 1")
    );
    expect(err.summary).toBe(
      'Code cell "Tab 1" (line 2): NameError: name \'x\' is not defined'
    );
  });

  it("prefixes only the source when there is no location", () => {
    const err = buildExecutionError("RuntimeError", "boom", [], cellOrigin("Tab 2"));
    expect(err.summary).toBe('Code cell "Tab 2": RuntimeError: boom');
  });

  it("formats a tree-script source", () => {
    const err = buildExecutionError("ValueError", "v", [], {
      kind: "tree-script",
      label: "scripts.fit",
    });
    expect(err.summary).toBe('Script "scripts.fit": ValueError: v');
  });

  it("formats an agent source with its tool name", () => {
    const err = buildExecutionError("ValueError", "v", [], {
      kind: "agent",
      label: "run-1",
      agentTool: "cell_run",
    });
    expect(err.summary).toBe('Agent cell_run "run-1": ValueError: v');
  });

  it("formats an unknown source generically", () => {
    const err = buildExecutionError("ValueError", "v", [], { kind: "unknown", label: "misc" });
    expect(err.summary).toBe('Execution "misc": ValueError: v');
  });
});
