/**
 * module-runtime.test.ts — Unit tests for module runtime helpers.
 */

import { describe, expect, it } from "vitest";

import { toPythonArgumentValue } from "./module-runtime";

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
