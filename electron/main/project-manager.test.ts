/**
 * project-manager.test.ts — Unit tests for ProjectManager.
 *
 * All comm interactions are mocked via a fake CommRouter.
 * Filesystem writes are tested against a temporary directory.
 *
 * Tests cover:
 * 1. save() sends pdv.project.save comm and waits for response.
 * 2. save() writes command-boxes.json.
 * 3. save() writes project.json with correct checksum from kernel response.
 * 4. save() rolls back (does not write project.json) on comm error.
 * 5. load() sends pdv.project.load and waits for pdv.project.loaded push.
 * 6. load() reads command-boxes.json after push.
 * 7. readManifest() parses project.json correctly.
 * 8. readManifest() throws on missing / malformed project.json.
 *
 * Reference: ARCHITECTURE.md §8
 */

import { describe, it } from "vitest";
import { ProjectManager } from "./project-manager";

describe("ProjectManager", () => {
  describe("save()", () => {
    it("sends pdv.project.save comm", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("writes command-boxes.json", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("writes project.json with checksum from kernel", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("does not write project.json when kernel returns error", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });
  });

  describe("load()", () => {
    it("sends pdv.project.load comm", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("waits for pdv.project.loaded push notification", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("reads command-boxes.json after project loaded", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });
  });

  describe("readManifest()", () => {
    it("parses valid project.json", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });

    it("throws on missing project.json", async () => {
      // TODO: implement in Step 4
      throw new Error("not implemented");
    });
  });
});
