/**
 * index.test.ts — Smoke tests for the main process entry point.
 *
 * These tests verify that the startup sequence initialises the managers
 * in the correct order without actually spawning a kernel or creating a
 * BrowserWindow (both are mocked).
 *
 * Tests cover:
 * 1. main() creates a working directory.
 * 2. main() calls EnvironmentDetector.detect().
 * 3. main() calls KernelManager.start() before createWindow().
 * 4. On app 'before-quit', KernelManager.shutdown() is called.
 * 5. Startup failure causes app.exit(1).
 *
 * Reference: ARCHITECTURE.md §4.1
 */

describe("main process startup", () => {
  it("creates the working directory", async () => {
    // TODO: implement in Step 5
    throw new Error("not implemented");
  });

  it("calls EnvironmentDetector.detect()", async () => {
    // TODO: implement in Step 5
    throw new Error("not implemented");
  });

  it("starts KernelManager before creating window", async () => {
    // TODO: implement in Step 5
    throw new Error("not implemented");
  });

  it("calls KernelManager.shutdown() on quit", async () => {
    // TODO: implement in Step 5
    throw new Error("not implemented");
  });
});
