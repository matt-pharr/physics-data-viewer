/**
 * pyproject.test.ts — Unit tests for pyproject.toml generation.
 */

import { describe, expect, it } from "vitest";

import {
  generatePyproject,
  normalizeDistName,
  parseDependencies,
  specName,
} from "./pyproject";

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

describe("parseDependencies", () => {
  it("reads [project].dependencies as a list of strings", async () => {
    const toml = generatePyproject({ dependencies: ["numpy", "scipy>=1.10"] });
    expect(await parseDependencies(toml)).toEqual(["numpy", "scipy>=1.10"]);
  });

  it("returns [] when the [project].dependencies field is absent", async () => {
    expect(await parseDependencies('[project]\nname = "x"\nversion = "0.1.0"\n')).toEqual([]);
  });

  it("returns [] for unparseable TOML", async () => {
    expect(await parseDependencies("this is not valid toml === [[[")).toEqual([]);
  });

  it("ignores non-string entries in the dependencies array", async () => {
    const toml = '[project]\nname = "x"\nversion = "0.1.0"\ndependencies = ["numpy", 42]\n';
    expect(await parseDependencies(toml)).toEqual(["numpy"]);
  });
});

describe("normalizeDistName / specName", () => {
  it("normalizes distribution names per PEP 503", () => {
    expect(normalizeDistName("NumPy_Test")).toBe("numpy-test");
    expect(normalizeDistName("scikit.learn")).toBe("scikit-learn");
    expect(normalizeDistName("foo___bar..baz")).toBe("foo-bar-baz");
  });

  it("extracts and normalizes the distribution name from a PEP 508 spec", () => {
    expect(specName("scipy>=1.10")).toBe("scipy");
    expect(specName("pkg[extra]>=1.0")).toBe("pkg");
    expect(specName("Numpy_Test")).toBe("numpy-test");
    expect(specName("requests ~= 2.0")).toBe("requests");
  });
});
