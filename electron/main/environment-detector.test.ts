/**
 * environment-detector.test.ts — Unit tests for EnvironmentDetector.
 *
 * All subprocess calls are mocked — no real Python is executed.
 *
 * Tests cover:
 * 1. detect() returns configured path when provided.
 * 2. detect() falls back to CONDA_PREFIX if no configured path.
 * 3. detect() falls back to system Python if no conda/venv.
 * 4. hasPDVKernel() returns true/false based on mock output.
 * 5. listAll() returns conda environments when conda is available.
 *
 * Reference: ARCHITECTURE.md §5.1
 */

import { EnvironmentDetector } from "./environment-detector";

describe("EnvironmentDetector", () => {
  beforeEach(() => {
    EnvironmentDetector.clearCache();
  });

  describe("detect()", () => {
    it("uses configuredPath when provided", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("falls back to CONDA_PREFIX", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("falls back to system python when no env vars set", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("throws if no Python is found anywhere", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });
  });

  describe("hasPDVKernel()", () => {
    it("returns true when pdv_kernel is installed", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("returns false when pdv_kernel is absent", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });
  });

  describe("listAll()", () => {
    it("includes system python in result", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });
  });
});
