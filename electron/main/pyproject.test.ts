/**
 * pyproject.test.ts — Unit tests for pyproject.toml generation.
 */

import { describe, expect, it } from "vitest";

import { generatePyproject } from "./pyproject";

describe("generatePyproject", () => {
  it("emits a [project] table with the given dependencies", () => {
    const toml = generatePyproject({ dependencies: ["numpy", "matplotlib"] });
    expect(toml).toContain("[project]");
    expect(toml).toContain('name = "pdv-project"');
    expect(toml).toContain('requires-python = ">=3.10"');
    expect(toml).toContain('"numpy"');
    expect(toml).toContain('"matplotlib"');
  });

  it("emits an empty dependency array when there are no packages", () => {
    const toml = generatePyproject({ dependencies: [] });
    expect(toml).toContain("dependencies = []");
  });

  it("honors a custom name and requires-python", () => {
    const toml = generatePyproject({
      dependencies: [],
      name: "my-experiment",
      requiresPython: ">=3.12",
    });
    expect(toml).toContain('name = "my-experiment"');
    expect(toml).toContain('requires-python = ">=3.12"');
  });

  it("quotes dependency specs that contain comparison operators", () => {
    const toml = generatePyproject({ dependencies: ["scipy>=1.10,<2"] });
    expect(toml).toContain('"scipy>=1.10,<2"');
  });

  it("does not list pdv-python (it is app-managed)", () => {
    const toml = generatePyproject({ dependencies: ["numpy"] });
    expect(toml).not.toContain("pdv-python");
  });
});
