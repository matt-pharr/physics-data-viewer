/**
 * mcp-config-writer.test.ts — Tests for writeMcpConfigFile.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { McpStatus } from "../ipc";
import { MCP_CONFIG_FILENAME, writeMcpConfigFile } from "./mcp-config-writer";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-mcpcfg-test-"));
  tempDirs.push(dir);
  return dir;
}

const RUNNING_STATUS: McpStatus = {
  running: true,
  host: "127.0.0.1",
  port: 7391,
  token: "secret-token",
  url: "http://127.0.0.1:7391/mcp",
  generation: 0,
  clientCount: 0,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeMcpConfigFile", () => {
  it("writes a Claude-Code-shaped mcpServers config", async () => {
    const dir = makeTempDir();
    const configPath = await writeMcpConfigFile(dir, RUNNING_STATUS);

    expect(configPath).toBe(path.join(dir, MCP_CONFIG_FILENAME));
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed).toEqual({
      mcpServers: {
        pdv: {
          type: "http",
          url: "http://127.0.0.1:7391/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      },
    });
  });

  it("creates the file mode 0600 so the bearer token is not world-readable", () => {
    if (process.platform === "win32") return; // mode bits are a no-op on Windows
    return writeMcpConfigFile(makeTempDir(), RUNNING_STATUS).then((configPath) => {
      const mode = fs.statSync(configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  it("overwrites a stale config on a second write", async () => {
    const dir = makeTempDir();
    await writeMcpConfigFile(dir, { ...RUNNING_STATUS, port: 1111, url: "http://127.0.0.1:1111/mcp" });
    const configPath = await writeMcpConfigFile(dir, RUNNING_STATUS);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.mcpServers.pdv.url).toBe("http://127.0.0.1:7391/mcp");
  });

  it("throws when the MCP server is not running", async () => {
    const dir = makeTempDir();
    await expect(
      writeMcpConfigFile(dir, {
        running: false,
        host: "127.0.0.1",
        port: null,
        token: null,
        url: null,
        generation: 0,
        clientCount: 0,
      }),
    ).rejects.toThrow(/not running/);
  });
});
