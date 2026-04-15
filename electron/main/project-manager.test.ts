/**
 * project-manager.test.ts — Unit tests for ProjectManager.
 *
 * All comm interactions are mocked via a fake CommRouter.
 * Filesystem writes are tested against a temporary directory.
 *
 * Tests cover:
 * 1. save() sends pdv.project.save comm and waits for response.
 * 2. save() writes code-cells.json.
 * 3. save() writes project.json with correct checksum from kernel response.
 * 4. save() rolls back (does not write project.json) on comm error.
 * 5. load() sends pdv.project.load and waits for pdv.project.loaded push.
 * 6. load() reads code-cells.json after push.
 * 7. readManifest() parses project.json correctly.
 * 8. readManifest() returns default manifest on missing project.json.
 * 9. readManifest() throws PDVSchemaVersionError on future schema major version.
 * 10. createWorkingDir() creates a directory that exists on disk.
 * 11. deleteWorkingDir() removes the directory.
 *
 * Reference: ARCHITECTURE.md §8
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { CommRouter } from "./comm-router";
import { PDVCommError } from "./comm-router";
import { ProjectManager, PDVSchemaVersionError } from "./project-manager";
import type { CodeCellData } from "./ipc";

const EMPTY_CELLS: CodeCellData = { tabs: [], activeTabId: 1 };
import { PDVMessageType, getAppVersion, setAppVersion } from "./pdv-protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ok PDVMessage response for a given request type.
 *
 * @param payload - Optional payload fields.
 * @returns Minimal PDVMessage with status='ok'.
 */
function makeOkResponse(payload: Record<string, unknown> = {}) {
  return {
    pdv_version: getAppVersion(),
    msg_id: "resp-1",
    in_reply_to: "req-1",
    type: "response",
    status: "ok" as const,
    payload,
  };
}

/**
 * Build a minimal error PDVMessage for testing error-path behavior.
 *
 * @param code - Machine-readable error code.
 * @param message - Human-readable message.
 * @returns PDVCommError wrapping the error response.
 */
function makeCommError(code = "save.failed", message = "kernel error") {
  const errResponse = {
    pdv_version: getAppVersion(),
    msg_id: "resp-err",
    in_reply_to: "req-1",
    type: "error",
    status: "error" as const,
    payload: { code, message },
  };
  return new PDVCommError(message, code, errResponse);
}

/**
 * Create a mock CommRouter with vi.fn() stubs for request/onPush/offPush.
 *
 * @returns Typed mock CommRouter.
 */
function makeMockRouter(): {
  router: CommRouter;
  requestMock: ReturnType<typeof vi.fn>;
  onPushMock: ReturnType<typeof vi.fn>;
  offPushMock: ReturnType<typeof vi.fn>;
  triggerPush: (type: string) => void;
} {
  const pushHandlers = new Map<string, Array<() => void>>();

  const onPushMock = vi.fn((type: string, handler: () => void) => {
    const list = pushHandlers.get(type) ?? [];
    list.push(handler);
    pushHandlers.set(type, list);
  });

  const offPushMock = vi.fn((type: string, handler: () => void) => {
    const list = pushHandlers.get(type) ?? [];
    pushHandlers.set(
      type,
      list.filter((h) => h !== handler)
    );
  });

  const requestMock = vi.fn(async () => makeOkResponse());

  const router = {
    request: requestMock,
    onPush: onPushMock,
    offPush: offPushMock,
  } as unknown as CommRouter;

  const triggerPush = (type: string): void => {
    const handlers = pushHandlers.get(type) ?? [];
    for (const h of [...handlers]) h();
  };

  return { router, requestMock, onPushMock, offPushMock, triggerPush };
}


describe("ProjectManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    setAppVersion("0.0.7");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-pm-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // save()
  // -------------------------------------------------------------------------

  describe("save()", () => {
    it("sends pdv.project.save comm with save_dir", async () => {
      const { router, requestMock } = makeMockRouter();
      requestMock.mockResolvedValue(makeOkResponse({ checksum: "abc123" }));

      const pm = new ProjectManager(router);
      await pm.save(tmpDir, EMPTY_CELLS);

      expect(requestMock).toHaveBeenCalledOnce();
      expect(requestMock).toHaveBeenCalledWith(PDVMessageType.PROJECT_SAVE, {
        save_dir: tmpDir,
      }, { keepAlivePushType: PDVMessageType.PROGRESS });
    });

    it("writes code-cells.json after the comm resolves", async () => {
      const callOrder: string[] = [];

      const { router, requestMock } = makeMockRouter();
      requestMock.mockImplementation(async () => {
        callOrder.push("comm");
        return makeOkResponse({ checksum: "chk" });
      });

      const pm = new ProjectManager(router);
      const cells: CodeCellData = {
        tabs: [{ id: 1, code: "print('hi')" }],
        activeTabId: 1,
      };
      await pm.save(tmpDir, cells);
      callOrder.push("files-written");

      // Verify comm was called before file writes.
      expect(callOrder[0]).toBe("comm");

      const cbContent = await fs.readFile(
        path.join(tmpDir, "code-cells.json"),
        "utf8"
      );
      expect(JSON.parse(cbContent)).toEqual(cells);
    });

    it("writes project.json with checksum from kernel", async () => {
      const { router, requestMock } = makeMockRouter();
      requestMock.mockResolvedValue(
        makeOkResponse({ checksum: "deadbeef1234" })
      );

      const pm = new ProjectManager(router);
      await pm.save(tmpDir, EMPTY_CELLS);

      const raw = await fs.readFile(
        path.join(tmpDir, "project.json"),
        "utf8"
      );
      const manifest = JSON.parse(raw);
      expect(manifest.tree_checksum).toBe("deadbeef1234");
      expect(manifest.schema_version).toBeDefined();
      expect(manifest.modules).toEqual([]);
      expect(manifest.module_settings).toEqual({});
    });

    it("does not write project.json when kernel returns error", async () => {
      const { router, requestMock } = makeMockRouter();
      requestMock.mockRejectedValue(makeCommError("save.failed"));

      const pm = new ProjectManager(router);
      await expect(pm.save(tmpDir, EMPTY_CELLS)).rejects.toThrow();

      // project.json must NOT exist.
      await expect(
        fs.stat(path.join(tmpDir, "project.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses nullish codeCells payloads before any disk write", async () => {
      const { router, requestMock } = makeMockRouter();
      requestMock.mockResolvedValue(makeOkResponse({ checksum: "c1" }));

      const pm = new ProjectManager(router);
      await expect(
        pm.save(tmpDir, null as unknown as CodeCellData)
      ).rejects.toThrow(/CodeCellData/);
      await expect(
        pm.save(tmpDir, undefined as unknown as CodeCellData)
      ).rejects.toThrow(/CodeCellData/);
      expect(requestMock).not.toHaveBeenCalled();
      await expect(
        fs.stat(path.join(tmpDir, "code-cells.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses malformed cells shapes", async () => {
      const { router } = makeMockRouter();
      const pm = new ProjectManager(router);
      await expect(
        pm.save(tmpDir, { tabs: "not-an-array" } as unknown as CodeCellData)
      ).rejects.toThrow(/tabs/);
      await expect(
        pm.save(tmpDir, { tabs: [], activeTabId: "one" } as unknown as CodeCellData)
      ).rejects.toThrow(/activeTabId/);
      await expect(
        pm.save(
          tmpDir,
          { tabs: [{ id: "x", code: "" }], activeTabId: 1 } as unknown as CodeCellData
        )
      ).rejects.toThrow(/numeric id/);
    });

    it("writes comm, then code-cells.json, then project.json — in that order", async () => {
      const { router, requestMock } = makeMockRouter();

      // During the comm call neither output file should exist yet.
      requestMock.mockImplementation(async () => {
        await expect(
          fs.stat(path.join(tmpDir, "code-cells.json"))
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.stat(path.join(tmpDir, "project.json"))
        ).rejects.toMatchObject({ code: "ENOENT" });
        return makeOkResponse({ checksum: "c1" });
      });

      const pm = new ProjectManager(router);
      await pm.save(tmpDir, EMPTY_CELLS);

      // After save both files must exist.
      await expect(
        fs.stat(path.join(tmpDir, "code-cells.json"))
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(tmpDir, "project.json"))
      ).resolves.toBeDefined();

      // code-cells.json must have been written before project.json.
      const cbStat = await fs.stat(path.join(tmpDir, "code-cells.json"));
      const pjStat = await fs.stat(path.join(tmpDir, "project.json"));
      expect(cbStat.birthtimeMs).toBeLessThanOrEqual(pjStat.birthtimeMs);
    });
  });

  // -------------------------------------------------------------------------
  // load()
  // -------------------------------------------------------------------------

  describe("load()", () => {
    it("sends pdv.project.load comm with save_dir", async () => {
      const { router, requestMock, triggerPush } = makeMockRouter();

      const pm = new ProjectManager(router);
      const loadPromise = pm.load(tmpDir);
      // Push fires immediately (before request resolves) — tests the race fix.
      triggerPush(PDVMessageType.PROJECT_LOADED);
      await loadPromise;

      expect(requestMock).toHaveBeenCalledOnce();
      expect(requestMock).toHaveBeenCalledWith(PDVMessageType.PROJECT_LOAD, {
        save_dir: tmpDir,
      }, { keepAlivePushType: PDVMessageType.PROGRESS });
    });

    it("waits for pdv.project.loaded push notification", async () => {
      const { router, onPushMock, triggerPush } = makeMockRouter();

      const pm = new ProjectManager(router);
      let resolved = false;

      const loadPromise = pm.load(tmpDir).then((r) => {
        resolved = true;
        return r;
      });

      // Not resolved yet (push not fired).
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Fire push — now it should resolve.
      triggerPush(PDVMessageType.PROJECT_LOADED);
      await loadPromise;
      expect(resolved).toBe(true);
      expect(onPushMock).toHaveBeenCalledWith(
        PDVMessageType.PROJECT_LOADED,
        expect.any(Function)
      );
    });

    it("reads code-cells.json from the save directory", async () => {
      const boxes = [{ id: 2, code: "x = 1" }];
      await fs.writeFile(
        path.join(tmpDir, "code-cells.json"),
        JSON.stringify(boxes),
        "utf8"
      );

      const { router, triggerPush } = makeMockRouter();
      const pm = new ProjectManager(router);

      const loadPromise = pm.load(tmpDir);
      // Push fires immediately — tests that the race is handled correctly.
      triggerPush(PDVMessageType.PROJECT_LOADED);
      const result = await loadPromise;

      expect(result.codeCells).toEqual(boxes);
    });
  });

  // -------------------------------------------------------------------------
  // readManifest()
  // -------------------------------------------------------------------------

  describe("readManifest()", () => {
    it("parses valid project.json", async () => {
      const manifest = {
        schema_version: "1.0",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "abc",
      };
      await fs.writeFile(
        path.join(tmpDir, "project.json"),
        JSON.stringify(manifest),
        "utf8"
      );

      const result = await ProjectManager.readManifest(tmpDir);
      expect(result.schema_version).toBe("1.0");
      expect(result.tree_checksum).toBe("abc");
      expect(result.modules).toEqual([]);
      expect(result.module_settings).toEqual({});
    });

    it("parses modules and module_settings when present", async () => {
      const manifest = {
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "abc",
        modules: [
          {
            module_id: "mod1",
            alias: "diagnosticA",
            version: "1.2.0",
            revision: "abc123",
          },
        ],
        module_settings: {
          diagnosticA: {
            threshold: 4,
            label: "shot-22",
          },
        },
      };
      await fs.writeFile(
        path.join(tmpDir, "project.json"),
        JSON.stringify(manifest),
        "utf8"
      );

      const result = await ProjectManager.readManifest(tmpDir);
      expect(result.modules).toEqual([
        {
          module_id: "mod1",
          alias: "diagnosticA",
          version: "1.2.0",
          revision: "abc123",
        },
      ]);
      expect(result.module_settings).toEqual({
        diagnosticA: { threshold: 4, label: "shot-22" },
      });
    });

    it("returns a default manifest when project.json is missing (does not throw)", async () => {
      // tmpDir exists but has no project.json.
      const result = await ProjectManager.readManifest(tmpDir);
      expect(result).toBeDefined();
      expect(result.schema_version).toBeDefined();
      expect(result.modules).toEqual([]);
      expect(result.module_settings).toEqual({});
    });

    it("throws PDVSchemaVersionError on future schema major version", async () => {
      const manifest = {
        schema_version: "99.0",
        saved_at: "2099-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
      };
      await fs.writeFile(
        path.join(tmpDir, "project.json"),
        JSON.stringify(manifest),
        "utf8"
      );

      await expect(ProjectManager.readManifest(tmpDir)).rejects.toThrow(
        PDVSchemaVersionError
      );
    });
  });

  // -------------------------------------------------------------------------
  // createWorkingDir() / deleteWorkingDir()
  // -------------------------------------------------------------------------

  describe("createWorkingDir()", () => {
    it("creates a directory that exists on disk", async () => {
      const { router } = makeMockRouter();
      const pm = new ProjectManager(router);

      const dir = await pm.createWorkingDir();
      try {
        const stat = await fs.stat(dir);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("deleteWorkingDir()", () => {
    it("removes the directory", async () => {
      const { router } = makeMockRouter();
      const pm = new ProjectManager(router);

      const dir = await pm.createWorkingDir();
      await pm.deleteWorkingDir(dir);

      await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
