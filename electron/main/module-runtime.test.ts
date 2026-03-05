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
      "\"5); __import__('os').system('evil')#\""
    );
  });

  it("returns null for empty string input", () => {
    expect(toPythonArgumentValue("   ")).toBeNull();
  });
});
