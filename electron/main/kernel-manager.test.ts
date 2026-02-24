/**
 * kernel-manager.test.ts — Unit tests for KernelManager.
 *
 * All subprocess spawning and Jupyter client calls are mocked.
 *
 * Tests cover:
 * 1. start() transitions status idle → starting → ready.
 * 2. start() sends pdv.init after pdv.ready is received.
 * 3. shutdown() deletes the working directory by default.
 * 4. shutdown(false) preserves the working directory.
 * 5. Kernel process crash emits 'died' event.
 * 6. restart() re-sends pdv.init.
 *
 * Reference: ARCHITECTURE.md §4.1
 */

import { KernelManager } from "./kernel-manager";

describe("KernelManager", () => {
  describe("start()", () => {
    it("transitions status to ready after pdv.ready received", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("sends pdv.init after pdv.ready", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("rejects if kernel does not start within timeout", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });

  describe("shutdown()", () => {
    it("deletes working directory by default", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("preserves working directory when deleteWorkingDir=false", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });

  describe("kernel crash", () => {
    it("emits 'died' event on unexpected process exit", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });

  describe("restart()", () => {
    it("re-sends pdv.init after restart", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });
});
