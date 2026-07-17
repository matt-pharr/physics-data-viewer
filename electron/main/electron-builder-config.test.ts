/**
 * electron-builder-config.test.ts — Guards on the packaging manifest.
 *
 * The runtime resolvers expect specific directories under
 * `process.resourcesPath` in packaged builds; nothing else exercises
 * electron-builder.yml in CI, so these assertions keep the manifest and the
 * resolvers from drifting apart. PR #347 review B3: pdv-julia was missing
 * from extraResources, so the packaged one-click PDVKernel install could
 * never work outside dev.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const configText = fs.readFileSync(
  path.join(__dirname, "..", "electron-builder.yml"),
  "utf8",
);

describe("electron-builder.yml extraResources", () => {
  it("bundles pdv-python for the packaged pip install (§10.3)", () => {
    expect(configText).toMatch(/from: \.\.\/pdv-python\s+to: pdv-python/);
  });

  it("bundles pdv-julia for the packaged PDVKernel install (§10.7.4, review B3)", () => {
    // resolveBundledPDVJuliaPath() resolves <resourcesPath>/pdv-julia and
    // requires its Project.toml, so the filter must not exclude it.
    expect(configText).toMatch(/from: \.\.\/pdv-julia\s+to: pdv-julia/);
    const juliaBlock = configText.slice(configText.indexOf("from: ../pdv-julia"));
    expect(juliaBlock).not.toMatch(/!\s*\*?\*?\/?Project\.toml/);
  });

  it("bundles the pdv-python wheel and uv binary on every desktop platform (§10.5.6–7)", () => {
    const macBlock = configText.slice(configText.indexOf("mac:"), configText.indexOf("dmg:"));
    const linuxBlock = configText.slice(configText.indexOf("linux:"));
    for (const block of [macBlock, linuxBlock]) {
      expect(block).toContain("to: uv");
      expect(block).toContain("to: pdv-python-wheel");
    }
  });
});
