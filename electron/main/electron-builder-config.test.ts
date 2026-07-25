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

  it("ships the pdv-server bundle as a real file outside the asar (§2.1.1)", () => {
    // server-supervisor.ts resolves <Resources>/pdv-server/pdv-server.cjs in
    // packaged builds; plain Node (ELECTRON_RUN_AS_NODE) cannot require()
    // from inside app.asar, so the bundle must ride extraResources.
    expect(configText).toMatch(/from: dist\/server-bundle\s+to: pdv-server/);
    // ...and the build must actually produce that directory.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["build"]).toContain("build:server");
    expect(pkg.scripts["build:server"]).toContain("scripts/build-server.mjs");
    // The builder script owns the outfile path and the version stamp; assert
    // against it rather than an inline esbuild command line.
    const buildServer = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "build-server.mjs"),
      "utf8",
    );
    expect(buildServer).toContain('"server-bundle"');
    expect(buildServer).toContain('"pdv-server.cjs"');
    expect(buildServer).toContain("PDV_BUILD_VERSION");
  });

  it("keeps the server bundle out of the asar (it would be dead weight there)", () => {
    // `dist/**/*` in `files` would otherwise copy the bundle into app.asar,
    // where the plain-Node child can never require it.
    expect(configText).toMatch(/- "!dist\/server-bundle\/\*\*"/);
  });

  it("excludes local dev droppings from the bundled pdv-python tree", () => {
    // A developer machine's uv venv is >100 MB and every file in it would be
    // codesigned; the linter/build caches are pure noise.
    const pythonBlock = configText.slice(
      configText.indexOf("from: ../pdv-python"),
      configText.indexOf("from: ../pdv-julia"),
    );
    for (const pattern of ["!.venv/**", "!build/**", "!*.egg-info/**"]) {
      expect(pythonBlock).toContain(pattern);
    }
  });

  it("unpacks zeromq from the asar for the pdv-server's PDV_ZEROMQ_PATH (§2.1.1)", () => {
    // server-supervisor.ts points PDV_ZEROMQ_PATH at
    // <Resources>/app.asar.unpacked/node_modules/zeromq; the .node binary
    // there only exists if zeromq stays in asarUnpack. cmake-ts is on
    // zeromq's runtime require path (lib/load-addon.js), and plain Node
    // cannot resolve modules from inside the asar, so it must be unpacked
    // alongside zeromq or the packaged pdv-server dies on first kernel start.
    const unpackBlock = configText.slice(configText.indexOf("asarUnpack:"));
    expect(unpackBlock).toMatch(/- "node_modules\/zeromq\/\*\*"/);
    expect(unpackBlock).toMatch(/- "node_modules\/cmake-ts\/\*\*"/);
  });
});
